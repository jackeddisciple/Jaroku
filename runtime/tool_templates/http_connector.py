"""HTTP connector — requests to allowlisted domains, and nothing else.

Reviewed template. Copied byte-for-byte into generated projects; the builder model is shown
only the signature and may not rewrite it.

THIS IS NOT A CONNECTOR, IT IS AN ESCAPE HATCH, and the difference decides everything below.
Gmail talks to Gmail. Stripe talks to Stripe. This one talks to whatever a workspace named, which
means the safety property cannot come from the service at the other end — it has to come from
this file. The allowlist IS the connector; without it correct, there is no connector, only a
request-forger running model-written Python inside somebody's infrastructure.

Auth: the allowlist itself, plus one optional default header.

    HTTP_ALLOWED_DOMAINS   comma-separated exact hostnames: api.example.com,hooks.example.net
    HTTP_AUTH_HEADER       optional, a raw header sent on every request: `Bearer sk-...`, or
                           the whole line `Authorization: Bearer sk-...`

WHAT IS REFUSED, AND WHY EACH ONE IS A SEPARATE RULE RATHER THAN A CLEVER SINGLE CHECK:

  A HOST NOT ON THE LIST. Exact match, lowercased, punycode. No wildcards — `*.example.com` is
  not supported and will not be, because the domain somebody would reach for a wildcard on is a
  shared one (`*.herokuapp.com`, `*.blob.core.windows.net`), and a wildcard there grants every
  tenant of that platform, which is everybody.

  ANYTHING THAT IS NOT HTTPS. No plain http, no file://, no ftp://, no gopher — urllib speaks
  several of those, and `file:///etc/passwd` is a perfectly well-formed URL.

  A CREDENTIAL IN THE URL. `https://user:pass@host/` is rejected before anything is sent, and the
  URL is never echoed back in the refusal, because the refusal lands in a trace that is stored.

  A PRIVATE, LOOPBACK, LINK-LOCAL OR RESERVED ADDRESS, whatever the name resolved to and however
  it was spelled. `169.254.169.254` is the cloud metadata endpoint — how a compromised container
  steals the credentials of the machine running it — and `::ffff:a9fe:a9fe` is the same address
  in a different notation. An allowed domain that resolves into one of those blocks is refused
  whole, not partially: a name answering with one public and one link-local address is a name a
  round-robin resolver could route to the dangerous one on the very next lookup.

  A REDIRECT THAT LEAVES THE HOST. Not "leaves the allowlist" — leaves the HOST. Following a
  redirect from one allowed domain to another allowed one is defensible and is refused anyway,
  because an escape hatch's job is to be boring: a chain of allowed hops is a thing somebody has
  to reason about, and the tool can simply report the Location and let the agent decide.

AND THE ADDRESS IS PINNED, WHICH IS THE RULE THE OTHERS DEPEND ON. Checking a hostname and then
handing the hostname to urllib is a check that proves nothing: DNS is controlled by whoever owns
the domain, and `api.attacker.example` can answer with a public address for the millisecond this
file looks and with 169.254.169.254 for the millisecond the socket connects. So the name is
resolved once, every answer is checked, and the connection is made to a LITERAL ADDRESS while the
Host header and the TLS SNI keep the real hostname — so the certificate is still validated
against the name, and nothing resolves anything a second time.

ONE DEVIATION FROM THE CONNECTOR SPECIFICATION, RECORDED RATHER THAN HIDDEN. It asks for
`urllib.request` and this file uses it — but pinning cannot be expressed through `urlopen` alone,
which resolves the name itself inside `connect()`, in exactly the window the requirement exists
to close. So the opener is `urllib.request`'s, built with a connection class that overrides where
the socket goes and nothing else. It is still the standard library and still no dependency.

AND ONE TOOL, NOT TWO. The specification describes a second, `http_webhook_listen`, which blocks
on an inbound port until a request arrives. It is not here, and the specification's own catalog
entry does not list it either. A hosted run has no inbound listener — the sandbox's network is
outbound-only and its egress policy has no concept of accepting a connection — so the tool would
work on a laptop and raise everywhere the product actually runs, which is the worst shape a tool
can have: present in the prompt, selected by a model, and failing at the point of use. It is
recorded as a known gap in the README rather than shipped half-working.

Environment:
    HTTP_ALLOWED_DOMAINS

A tool that could not do its job raises. It does not return the reason as if it were an answer.

That distinction is the whole point of the trace: LangChain records a returned string as a
successful tool call, so a template that caught "not configured" and returned the message produced
a green, successful-looking step whose content happened to be an error — and the model, seeing a
normal tool result, treated the text as data and answered the user from it. The failure was
invisible in exactly the place built to make failures visible.

A REFUSED REQUEST RAISES TOO, and that is the same decision the Postgres connector makes about a
blocked write: the guard doing its job is the single most worth-seeing event in a trace. A run
that tried to reach the metadata endpoint and was stopped should be red, loudly, not a tidy
sentence the model summarises away.

Returning is still right for "the request was made and the server said no" — a 404 is a result.
"""

from __future__ import annotations

import ipaddress
import os
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from http.client import HTTPSConnection

from langchain_core.tools import tool

from . import require_enabled

REQUIRED_ENV = ["HTTP_ALLOWED_DOMAINS"]
AUTH_HEADER_ENV = "HTTP_AUTH_HEADER"

# The optional second door. Listed here for the same reason gmail.py lists its access token:
# `check_failures_raise()` strips these names too, and a way of being configured the check did not
# know about would make it pass on a machine where that variable happened to be exported.
OPTIONAL_ENV = [AUTH_HEADER_ENV]

METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")

# 256 KB, the same magnitude as the MCP bridge's result truncation, and for the same reason: what
# comes back goes into a context window at the provider's per-token price. One byte over is read
# on purpose, so "exactly at the cap" and "cut off" are distinguishable.
MAX_BODY_BYTES = 256 * 1024
DEFAULT_TIMEOUT_S = 30
MAX_TIMEOUT_S = 30
MAX_RESPONSE_HEADERS = 40

# Response headers refused on the way back. A DENYLIST here, which is the opposite of the Stripe
# connector's allowlist, and the asymmetry is deliberate: a payment object is a record about a
# person and its unknown fields are the dangerous ones, while response headers are mostly
# `content-type` and rate-limit counters that an agent legitimately needs. What is removed is the
# short list of headers that can carry a credential into a stored trace.
STRIPPED_RESPONSE_HEADERS = frozenset(
    {"set-cookie", "set-cookie2", "cookie", "authorization", "proxy-authorization"}
)

# Request headers a caller may not set, whatever it passes.
#
# `host` IS THE LOAD-BEARING ONE. The socket goes to a pinned address and the Host header is what
# tells the server which site it is being asked for — so a caller-supplied Host is a way to reach
# a different virtual host at the same address than the one the allowlist approved. `content-
# length` and `transfer-encoding` are refused because urllib computes them, and two disagreeing
# copies of either is request smuggling.
REFUSED_REQUEST_HEADERS = frozenset({"host", "content-length", "transfer-encoding"})


# EVERY BLOCK NAMED, RATHER THAN LEFT TO `ipaddress`'s OWN PREDICATES.
#
# Written as a list because delegating entirely was tried first and had a hole in it:
# `100.64.0.0/10` — carrier-grade NAT, the address space a mobile network or a cloud NAT gateway
# puts real infrastructure behind — is NOT `is_private` in Python 3.12, having been in that table
# in earlier versions and taken out. So the refusal this connector promises would have quietly
# depended on which interpreter it happened to run under, and the one it runs under today gets it
# wrong. The standard library's predicates are still consulted, after this, as a supplement.
#
# This list is `sandbox/egressPolicy.ts`'s DENIED_IPV4_BLOCKS, entry for entry, and the two are
# asserted to agree by the egress suite on the Node side — see that file's own note on why the
# rule is stated twice at all.
DENIED_BLOCKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "0.0.0.0/8",  # "this network" / unspecified
        "10.0.0.0/8",  # RFC1918
        "100.64.0.0/10",  # carrier-grade NAT — the one Python's own table stopped covering
        "127.0.0.0/8",  # loopback
        "169.254.0.0/16",  # link-local — THE CLOUD METADATA ENDPOINT LIVES HERE
        "172.16.0.0/12",  # RFC1918
        "192.0.0.0/24",  # IETF protocol assignments
        "192.0.2.0/24",  # TEST-NET-1
        "192.168.0.0/16",  # RFC1918
        "198.18.0.0/15",  # benchmarking
        "198.51.100.0/24",  # TEST-NET-2
        "203.0.113.0/24",  # TEST-NET-3
        "224.0.0.0/4",  # multicast
        "240.0.0.0/4",  # reserved
        "::/128",  # unspecified
        "::1/128",  # loopback
        "fe80::/10",  # link-local
        "fc00::/7",  # unique local
        "ff00::/8",  # multicast
        "2001:db8::/32",  # documentation
        "2001::/32",  # Teredo
        "64:ff9b::/96",  # NAT64 well-known prefix
    )
)


class HttpRefused(RuntimeError):
    """The request was not made. Distinct from a request that was made and failed."""


# --- the allowlist ---------------------------------------------------------------------------


def _allowlist() -> set[str]:
    """The domains this workspace named, or RuntimeError naming the variable that is empty.

    AN EMPTY LIST REFUSES EVERYTHING, and it says so rather than defaulting to anything. There is
    no "unset means unrestricted" reading of this variable: unrestricted is the vulnerability.
    """
    # BEFORE THE CREDENTIAL CHECK — see require_enabled. The host already declines to inject a
    # disabled connector's credential, so without this the failure would name a credential that is
    # perfectly fine and send somebody to repair it.
    require_enabled("http", "The HTTP connector")
    raw = os.environ.get("HTTP_ALLOWED_DOMAINS", "")
    domains = {d.strip().lower().rstrip(".") for d in raw.split(",") if d.strip()}
    if not domains:
        raise RuntimeError(
            "The HTTP connector is not configured: HTTP_ALLOWED_DOMAINS is empty, so every "
            "request is refused. Set it to a comma-separated list of exact hostnames "
            "(api.example.com,hooks.example.net) in Jaroku's Connections tab, or in runtime/.env."
        )
    return domains


def normalise_domain(value: str) -> str | None:
    """One allowlist entry, or None when it is not a hostname.

    Exported under a plain name because the connections panel validates the same strings on the
    way in and the two must agree about what counts — a domain the panel accepts and this refuses
    is a workspace that configured the connector and cannot use it.

    A SCHEME, A PATH, A PORT OR A WILDCARD MAKES IT NOT A HOSTNAME, and each is refused rather
    than stripped. Stripping is how `https://evil.example/@api.example.com` becomes an entry
    somebody did not mean to write, and a wildcard is refused for the reason in the header.
    """
    text = value.strip().lower().rstrip(".")
    if not text or "*" in text or "/" in text or ":" in text or "@" in text or " " in text:
        return None
    try:
        # IDN, once, here. A domain stored in unicode and compared against a punycode hostname
        # never matches, which reads to a user as an allowlist that does not work.
        text = text.encode("idna").decode("ascii")
    except (UnicodeError, UnicodeDecodeError):
        return None
    if "." not in text or text.startswith(".") or ".." in text:
        return None
    return text


# --- addresses -------------------------------------------------------------------------------


def denied_address(ip: str) -> bool:
    """True for anything a sandbox must never reach, however the address is spelled.

    THE SAME REFUSAL `sandbox/egressPolicy.ts` MAKES, in the language this side of the boundary
    is written in. Two copies of a rule is normally how they drift, and the answer everywhere else
    in Jaroku is to have one — but the control plane cannot make this check for a request the
    sandbox originates, and the sandbox cannot call TypeScript. So it is stated twice, both times
    against the same list, and the egress suite on the Node side asserts the policy refuses what
    this refuses.

    TEXT MATCHING IS NOT ENOUGH, which is why every branch below goes through `ipaddress` and
    unwraps the v6 forms that carry a v4 inside them. `::ffff:169.254.169.254`,
    `::ffff:a9fe:a9fe` and `169.254.169.254` are one address written three ways, and a rule that
    matched the dotted spelling admits the other two.
    """
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return True  # not even an address — refuse rather than guess

    if address.version == 6:
        # Every well-known way of carrying a v4 destination inside a v6 address, unwrapped and
        # re-checked, so the v4 rules cannot be walked around by wearing a v6 suit. Teredo yields
        # a PAIR — the tunnel server and the client — and both are checked, because the one that
        # matters is whichever the packet ends up at.
        teredo = address.teredo
        carried = [address.ipv4_mapped, address.sixtofour, *(teredo or ())]
        if any(inner is not None and denied_address(str(inner)) for inner in carried):
            return True

    if any(address in block for block in DENIED_BLOCKS):
        return True

    # And the standard library's own predicates on top, which cover the same ground from the
    # other direction and pick up anything a future RFC adds to its table. Belt and braces, in
    # that order: the list above is the one this connector promises, and this is the supplement.
    return bool(
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )


def resolve_and_pin(host: str, port: int) -> list[str]:
    """Every address `host` answers with, refused whole if ANY of them is one we must not reach.

    "ANY", NOT "THE FIRST". A hostname answering with one public and one link-local address is a
    hostname a round-robin resolver could hand out the dangerous one of on the very next lookup,
    and pinning exists to remove exactly that non-determinism.
    """
    try:
        answers = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise HttpRefused(f"{host!r} did not resolve: {exc}") from exc

    addresses: list[str] = []
    for info in answers:
        ip = info[4][0]
        if ip not in addresses:
            addresses.append(ip)
    if not addresses:
        raise HttpRefused(f"{host!r} did not resolve to any address")

    denied = [ip for ip in addresses if denied_address(ip)]
    if denied:
        raise HttpRefused(
            f"{host!r} resolves to a private, loopback, link-local or reserved address "
            f"({', '.join(denied)}) and will not be connected to"
        )
    return addresses


# --- the pinned opener -----------------------------------------------------------------------


def _pinned_opener(ip: str) -> urllib.request.OpenerDirector:
    """A urllib opener whose socket goes to `ip` and whose TLS still checks the hostname.

    `self.host` is left alone on purpose: it is what fills the Host header and what is passed as
    `server_hostname` for SNI and certificate verification. Only the address the socket dials is
    replaced — which is the whole of the pinning, and the smallest change that achieves it.
    """

    class _Pinned(HTTPSConnection):
        def connect(self) -> None:  # type: ignore[override]
            sock = socket.create_connection((ip, self.port), self.timeout)
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)

    class _PinnedHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):  # type: ignore[override]
            return self.do_open(_Pinned, req, context=ssl.create_default_context())

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        """Refuses every redirect, which makes urllib hand the 3xx back as an HTTPError.

        Returning None here is urllib's own way of saying "do not follow"; the response is then
        raised with its Location header intact, which is what the caller is told about. See the
        header on why a redirect is reported rather than followed.
        """

        def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
            return None

    # NO PROXY HANDLER, DELIBERATELY. urllib reads `http_proxy` and `HTTPS_PROXY` from the
    # environment by default, and a proxy variable set in a sandbox would route every request
    # through a host nobody validated and undo the pinning entirely. `ProxyHandler({})` is how
    # urllib is told there is no proxy at all.
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}), _PinnedHandler(), _NoRedirect()
    )


# --- headers ---------------------------------------------------------------------------------


def parse_headers(text: str) -> dict[str, str]:
    """`Name: value` lines into a dict, refusing anything that could inject a second header.

    A NEWLINE IN A HEADER VALUE IS THE WHOLE OF HEADER INJECTION — one value carrying
    `\\r\\nX-Admin: true` is two headers by the time it reaches the wire. urllib would refuse most
    of these itself with an obscure error; refusing here produces a sentence that names the header.
    """
    headers: dict[str, str] = {}
    for line in text.replace("\r", "\n").split("\n"):
        if not line.strip():
            continue
        if ":" not in line:
            raise HttpRefused(f"{line.strip()[:60]!r} is not a `Name: value` header line")
        name, _, value = line.partition(":")
        name = name.strip()
        value = value.strip()
        if not name or any(c in name for c in " \t"):
            raise HttpRefused(f"{name[:40]!r} is not a header name")
        if name.lower() in REFUSED_REQUEST_HEADERS:
            raise HttpRefused(f"the {name} header is set by this tool and cannot be overridden")
        headers[name] = value
    return headers


def _auth_header() -> dict[str, str]:
    """`HTTP_AUTH_HEADER`, in either of the two shapes people write it.

    A bare value (`Bearer sk-...`) becomes an Authorization header; a full line
    (`X-Api-Key: sk-...`) becomes the header it names. Accepting both because both are what the
    documentation of every API this connector exists to reach looks like, and a workspace that
    pasted the wrong one would get a 401 with nothing anywhere saying why.

    The VALUE is never returned, logged, or included in any message this module raises.
    """
    raw = (os.environ.get(AUTH_HEADER_ENV) or "").strip()
    if not raw:
        return {}
    if "\n" in raw or "\r" in raw:
        raise RuntimeError(f"{AUTH_HEADER_ENV} contains a newline, which cannot be sent as a header")
    name, sep, value = raw.partition(":")
    if sep and name.strip() and " " not in name.strip():
        return {name.strip(): value.strip()}
    return {"Authorization": raw}


# --- the tool ----------------------------------------------------------------------------------


def check_url(raw: str, allowed: set[str]) -> tuple[str, int, str]:
    """Parse and refuse. Returns (hostname, port, url) for something safe to send.

    Every refusal here happens BEFORE a socket exists, which is the property the suite asserts by
    counting connections rather than by reading messages.
    """
    try:
        parts = urllib.parse.urlsplit(raw.strip())
    except ValueError as exc:
        raise HttpRefused(f"that is not a URL: {exc}") from exc

    if parts.scheme != "https":
        raise HttpRefused(
            f"only https is allowed, and this URL is {parts.scheme or 'schemeless'!s} — "
            "http, file, ftp and the rest are refused"
        )
    # The URL is NOT quoted back in any refusal from here on: userinfo carries a password, and
    # this message lands in a trace that is stored and broadcast.
    if parts.username or parts.password or "@" in (parts.netloc.split("]")[-1]):
        raise HttpRefused("that URL carries a credential in it, which is refused before anything is sent")

    host = (parts.hostname or "").lower().rstrip(".")
    if not host:
        raise HttpRefused("that URL has no host")
    try:
        host = host.encode("idna").decode("ascii")
    except (UnicodeError, UnicodeDecodeError):
        raise HttpRefused("that host is not a name that can be resolved") from None

    if host not in allowed:
        # The host IS named, and that is deliberate: it is the one piece of the URL that carries
        # no credential, and a refusal that does not say which host was refused is one nobody can
        # act on. The allowlist is named too, so the fix is obvious.
        raise HttpRefused(
            f"{host} is not in HTTP_ALLOWED_DOMAINS ({', '.join(sorted(allowed))}). "
            "Entries are exact hostnames — there are no wildcards."
        )

    # `.port` PARSES, and it raises for `https://host:notanumber/` — which urlsplit itself was
    # perfectly happy with. Left unguarded that ValueError escapes as an unhandled exception from
    # a function whose whole job is to turn bad input into a sentence.
    try:
        explicit_port = parts.port
    except ValueError:
        raise HttpRefused("that URL's port is not a number") from None
    if explicit_port is not None and not (1 <= explicit_port <= 65535):
        raise HttpRefused(f"{explicit_port} is not a port")

    port = explicit_port or 443
    netloc = f"{host}:{explicit_port}" if explicit_port else host
    rebuilt = urllib.parse.urlunsplit(("https", netloc, parts.path, parts.query, ""))
    return host, port, rebuilt


@tool
def http_request(
    method: str = "GET",
    url: str = "",
    headers: str = "",
    body: str = "",
    timeout: int = DEFAULT_TIMEOUT_S,
) -> str:
    """Make an HTTPS request to a domain the workspace has explicitly allowed.

    This reaches a third-party server over the network. A POST, PUT, PATCH or DELETE may change
    something there and cannot be undone by this tool.

    `url` must be https and its host must be listed in HTTP_ALLOWED_DOMAINS exactly — there are
    no wildcards, and a host that resolves to a private address is refused. `headers` is
    newline-separated `Name: value` lines. `body` is sent as-is; when it is present and no
    Content-Type was given, application/json is assumed. Redirects are reported, not followed.
    """
    # THE CONFIGURATION CHECK IS FIRST, before any argument is judged. An unconfigured connector
    # must RAISE rather than return a sentence about a bad method, or `check_failures_raise()`
    # would be satisfied by an argument complaint and stop proving the thing it exists to prove.
    allowed = _allowlist()
    default_headers = _auth_header()

    verb = (method or "GET").strip().upper()
    if verb not in METHODS:
        return f"{verb!r} is not a method this tool sends. Use one of: {', '.join(METHODS)}."
    if not url.strip():
        return "Cannot make a request: `url` is empty."
    timeout = max(1, min(int(timeout or DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S))

    host, port, target = check_url(url, allowed)
    sent = {**default_headers, **parse_headers(headers)}
    payload = body.encode("utf-8") if body else None
    if payload is not None and not any(k.lower() == "content-type" for k in sent):
        sent["Content-Type"] = "application/json"

    ips = resolve_and_pin(host, port)
    opener = _pinned_opener(ips[0])
    request = urllib.request.Request(target, data=payload, headers=sent, method=verb)

    started = time.monotonic()
    try:
        response = opener.open(request, timeout=timeout)
        status = response.status
    except urllib.error.HTTPError as exc:
        # NOT AN ERROR HERE. urllib raises for every non-2xx, and a 404 or a 500 is an answer the
        # agent asked for. The object is still a readable response, so it is treated as one — and
        # a 3xx arrives this way too, because the redirect handler refused to follow it.
        response, status = exc, exc.code
    except urllib.error.URLError as exc:
        raise RuntimeError(f"The request to {host} failed: {type(exc.reason).__name__}: {exc.reason}") from exc
    except (TimeoutError, socket.timeout) as exc:
        raise RuntimeError(f"The request to {host} timed out after {timeout}s") from exc
    except ssl.SSLError as exc:
        raise RuntimeError(f"TLS to {host} failed: {exc}") from exc

    try:
        raw = response.read(MAX_BODY_BYTES + 1)
    except (TimeoutError, socket.timeout) as exc:
        raise RuntimeError(f"Reading the response from {host} timed out after {timeout}s") from exc
    finally:
        response.close()

    elapsed_ms = int((time.monotonic() - started) * 1000)
    truncated = len(raw) > MAX_BODY_BYTES
    text = raw[:MAX_BODY_BYTES].decode("utf-8", errors="replace")

    # STRIPPED FIRST, THEN CAPPED, and the order is not cosmetic. Capping first would let a server
    # push the headers worth reading out of view behind forty Set-Cookies — and the count is the
    # server's to choose, which makes it the server's choice what an agent gets to see.
    shown = []
    for name, value in response.headers.items():
        if name.lower() in STRIPPED_RESPONSE_HEADERS:
            continue
        if len(shown) >= MAX_RESPONSE_HEADERS:
            shown.append(f"  (further headers omitted)")
            break
        shown.append(f"  {name}: {value}")

    location = response.headers.get("Location")
    if 300 <= status < 400 and location:
        # REPORTED, NEVER FOLLOWED, and the report says whether the target would even be allowed.
        # A redirect is the one thing a server at an approved address controls completely, so
        # following it hands the choice of destination to whoever answered — which is how an
        # allowlist becomes advisory. Saying whether the target passes is what makes this useful
        # rather than merely safe: an agent redirected to an allowed host can ask for that URL
        # directly, at which point every check above runs again, on purpose.
        try:
            check_url(urllib.parse.urljoin(target, location), allowed)
            verdict = "it IS an allowed host, so ask for that URL directly"
        except HttpRefused as why:
            verdict = f"and it would be refused anyway — {why}"
        shown.append(f"  (redirect to {location[:200]} — NOT followed; {verdict})")

    return "\n".join(
        [
            f"{verb} {host} -> {status} in {elapsed_ms}ms",
            *shown,
            "",
            text,
            # No leading newline of its own: `join` already puts one there, and two produced a
            # blank line nobody asked for between the body and the note about it.
            *([f"(response truncated at {MAX_BODY_BYTES} bytes — ask for a narrower resource)"] if truncated else []),
        ]
    )


def allowed_domains_problem(raw: str) -> str | None:
    """Why this HTTP_ALLOWED_DOMAINS value is not usable, or None when it is.

    Here rather than in the panel that validates it, so the sentence a user reads while typing and
    the rule a run enforces are the same sentence and the same rule. A value the panel accepted
    and a run refuses is a workspace that configured the connector and cannot use it.
    """
    entries = [d.strip() for d in raw.split(",") if d.strip()]
    if not entries:
        return "no domains listed — an empty allowlist refuses every request"
    bad = [e for e in entries if normalise_domain(e) is None]
    if bad:
        return (
            f"not a hostname: {', '.join(repr(b) for b in bad[:3])}. Entries are bare exact "
            "hostnames — no scheme, no path, no port, and no wildcards."
        )
    return None


TEMPLATE_TOOLS = [http_request]
