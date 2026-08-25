"""The HTTP connector, driven adversarially, which is the only way it is worth driving.

THIS IS THE ONE CONNECTOR WHOSE SAFETY IS NOT SOMEBODY ELSE'S. Gmail talks to Gmail; the worst a
bug there does is fail. This one talks to whatever a workspace named, from inside somebody's
infrastructure, and every refusal it makes is the only thing standing between a model-written
prompt and the cloud metadata endpoint. So most of the assertions below are about requests that
must NOT happen, and they are counted rather than read: a refusal is only a refusal if no socket
was opened, and a message saying "refused" while a connection was made would pass a text check.

HOW A REAL REQUEST IS TESTED WITHOUT A REAL CERTIFICATE. The module's `socket` is replaced with a
shim that answers `getaddrinfo` from a script and points `create_connection` at a plain HTTP
server on this machine — so the template's own resolution, pinning, opener, redirect handling,
header stripping and truncation all run for real, against a server that records what it received.
TLS is a pass-through whose only job is to record the `server_hostname` it was handed, because
that value IS the property worth asserting: the socket goes to a literal address and the
certificate is still checked against the NAME, which is what makes pinning safe rather than merely
different.

  npm run test:connector-http
"""

from __future__ import annotations

import http.server
import os
import socket as real_socket
import sys
import threading
import time

failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    if ok:
        print(f"  ok   {name}")
    else:
        failures += 1
        print(f"  FAIL {name}{f' — {detail}' if detail else ''}")


# --- a server that records what it was actually sent ------------------------------------------

REPLY: dict = {"status": 200, "headers": [("Content-Type", "application/json")], "body": b"{}", "delay": 0.0}
RECEIVED: list[dict] = []


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _serve(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        RECEIVED.append(
            {
                "method": self.command,
                "path": self.path,
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "body": self.rfile.read(length) if length else b"",
            }
        )
        if REPLY["delay"]:
            time.sleep(REPLY["delay"])
        body = REPLY["body"]
        self.send_response(REPLY["status"])
        for name, value in REPLY["headers"]:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _serve

    def log_message(self, *args: object) -> None:
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
server.daemon_threads = True
SERVER_PORT = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()


# --- the shim the template sees instead of `socket` --------------------------------------------

DNS: dict[str, list[str]] = {}
DIALLED: list[tuple[str, int, object]] = []


class _SocketShim:
    """The real socket module, with resolution scripted and every dial recorded and redirected."""

    def __getattr__(self, name: str) -> object:
        return getattr(real_socket, name)

    def getaddrinfo(self, host: str, port: int, *a: object, **kw: object) -> list:
        answers = DNS.get(host)
        if answers is None:
            raise real_socket.gaierror(f"{host} not in the suite's DNS")
        return [(real_socket.AF_INET, real_socket.SOCK_STREAM, real_socket.IPPROTO_TCP, "", (ip, port)) for ip in answers]

    def create_connection(self, address: tuple[str, int], timeout: object = None, *a: object, **kw: object):
        DIALLED.append((address[0], address[1], timeout))
        # The template believes it is dialling the pinned public address. It is, as far as it can
        # tell — and the recorded tuple above is what the assertions read.
        return real_socket.create_connection(("127.0.0.1", SERVER_PORT), timeout)


class _PassthroughTLS:
    """No encryption, and one recorded fact: the name the certificate would be checked against."""

    def __init__(self) -> None:
        self.server_hostnames: list[str | None] = []

    def wrap_socket(self, sock: object, server_hostname: str | None = None, **kw: object) -> object:
        self.server_hostnames.append(server_hostname)
        return sock


from .. import http_connector as hc  # noqa: E402

TLS = _PassthroughTLS()
hc.socket = _SocketShim()  # type: ignore[assignment]
hc.ssl.create_default_context = lambda *a, **kw: TLS  # type: ignore[assignment]


def configure(domains: str = "api.example.com,hooks.example.net", auth: str | None = None) -> None:
    os.environ["HTTP_ALLOWED_DOMAINS"] = domains
    os.environ.pop("HTTP_AUTH_HEADER", None)
    if auth is not None:
        os.environ["HTTP_AUTH_HEADER"] = auth


def reply(status: int = 200, headers: list | None = None, body: bytes = b"{}", delay: float = 0.0) -> None:
    REPLY.update(
        {"status": status, "headers": headers if headers is not None else [("Content-Type", "application/json")], "body": body, "delay": delay}
    )


def reset() -> None:
    DIALLED.clear()
    RECEIVED.clear()
    TLS.server_hostnames.clear()
    DNS.clear()
    DNS["api.example.com"] = ["93.184.216.34"]
    DNS["hooks.example.net"] = ["93.184.216.35"]
    reply()


def call(**kwargs: object) -> tuple[str, str]:
    """Invoke the tool, returning (result, raised) — exactly one of which is non-empty."""
    try:
        return hc.http_request.invoke({"url": "https://api.example.com/v1/thing", **kwargs}), ""
    except Exception as exc:  # noqa: BLE001 — which exception is part of what is asserted
        return "", f"{type(exc).__name__}: {exc}"


configure()

# --- the happy path, so the refusals below mean something ---------------------------------------

print("\na request to an allowed domain is made, and made to the address that was checked")
reset()
reply(body=b'{"ok":true}')
out, raised = call(method="POST", body='{"q":1}', headers="X-Trace: abc")
check("it succeeded", not raised, raised)
check("the body came back", '{"ok":true}' in out)
check("the status and host are reported", "POST api.example.com -> 200" in out, out.split("\n")[0])
check("exactly one connection was opened", len(DIALLED) == 1, str(DIALLED))
check("...to the PINNED literal address, not a hostname", DIALLED[0][0] == "93.184.216.34")
check("...while TLS still checks the certificate against the NAME", TLS.server_hostnames == ["api.example.com"], str(TLS.server_hostnames))
check("the server got the method it was given", RECEIVED[0]["method"] == "POST")
check("...the path and query", RECEIVED[0]["path"] == "/v1/thing")
check("...the caller's header", RECEIVED[0]["headers"].get("x-trace") == "abc")
check("...the body", RECEIVED[0]["body"] == b'{"q":1}')
check("...and a Content-Type it did not have to name", RECEIVED[0]["headers"].get("content-type") == "application/json")
check("the Host header is the name, so a pinned address still reaches the right vhost", RECEIVED[0]["headers"].get("host", "").startswith("api.example.com"))

print("\nand a non-2xx is a result rather than a failure")
reset()
reply(status=404, body=b"nope")
out, raised = call()
check("a 404 does not raise", not raised, raised)
check("...and reports itself", "-> 404" in out and "nope" in out)

# --- the refusals, counted rather than read ------------------------------------------------------

print("\na host that is not on the list is refused before any socket exists")
reset()
out, raised = call(url="https://evil.example/x")
check("it raises", raised.startswith("HttpRefused") or raised.startswith("RuntimeError"), raised)
check("...naming the host and the variable", "evil.example" in raised and "HTTP_ALLOWED_DOMAINS" in raised)
check("...saying there are no wildcards", "no wildcards" in raised)
check("and NOTHING was dialled", len(DIALLED) == 0, str(DIALLED))

print("\nand a wildcard is not a way onto the list")
reset()
configure(domains="*.example.com")
out, raised = call(url="https://api.example.com/x")
check("an entry with a star matches nothing", raised != "", raised)
check("...and nothing was dialled", len(DIALLED) == 0)
configure()

print("\nsubdomains and suffixes are not the same string")
for host, why in [
    ("https://evil-api.example.com/x", "a prefix is not the host"),
    ("https://api.example.com.evil.test/x", "a suffix is not the host"),
    ("https://sub.api.example.com/x", "a subdomain is not the host"),
]:
    reset()
    out, raised = call(url=host)
    check(why, raised != "" and len(DIALLED) == 0, raised or "it was allowed")

print("\nnot-https is refused, whatever the scheme is")
for url in ["http://api.example.com/x", "file:///etc/passwd", "ftp://api.example.com/x", "gopher://api.example.com/x"]:
    reset()
    out, raised = call(url=url)
    check(f"{url.split(':')[0]} is refused", "only https is allowed" in raised, raised)
    check("...with nothing dialled", len(DIALLED) == 0)

print("\na credential in the URL is refused, and is not quoted back into the trace")
reset()
out, raised = call(url="https://someone:hunter2@api.example.com/x")
check("it raises", "carries a credential" in raised, raised)
check("...and the password is nowhere in the message", "hunter2" not in raised)
check("...and the username is not either", "someone" not in raised)
check("and nothing was dialled", len(DIALLED) == 0)

print("\nan allowed domain that resolves into a private range is refused")
for ip, what in [
    ("169.254.169.254", "the cloud metadata endpoint"),
    ("127.0.0.1", "loopback"),
    ("10.0.1.7", "RFC1918"),
    ("100.64.0.1", "carrier-grade NAT, which the standard library stopped calling private"),
    ("::ffff:169.254.169.254", "the metadata endpoint wearing a v6 suit"),
    ("::1", "v6 loopback"),
    ("fe80::1", "v6 link-local"),
]:
    reset()
    DNS["api.example.com"] = [ip]
    out, raised = call()
    check(f"{what} is refused", "private, loopback, link-local or reserved" in raised, raised or "it was allowed")
    check("...with nothing dialled", len(DIALLED) == 0)

print("\nand a name answering with one good address and one bad one is refused WHOLE")
reset()
DNS["api.example.com"] = ["93.184.216.34", "169.254.169.254"]
out, raised = call()
check("the public answer does not rescue it", raised != "", "it was allowed")
check("...because a round-robin resolver could hand out the other one next", len(DIALLED) == 0)

print("\nan empty allowlist refuses everything and says so")
reset()
configure(domains="")
out, raised = call()
check("it raises rather than defaulting to unrestricted", raised.startswith("RuntimeError"), raised)
check("...naming the variable", "HTTP_ALLOWED_DOMAINS is empty" in raised)
check("...and nothing was dialled", len(DIALLED) == 0)
configure()

# --- redirects -------------------------------------------------------------------------------------

print("\na redirect is reported and never followed")
reset()
reply(status=302, headers=[("Location", "https://evil.example/steal"), ("Content-Type", "text/html")], body=b"")
out, raised = call()
check("it does not raise — the allowed server did answer", not raised, raised)
check("exactly one connection was made", len(DIALLED) == 1, str(DIALLED))
check("...and the second hop was NOT taken", len(RECEIVED) == 1)
check("the Location is reported", "evil.example/steal" in out)
check("...as not followed", "NOT followed" in out)
check("...and the report says the target would be refused anyway", "would be refused" in out, out)

print("\nand a redirect to an allowed host is still not followed")
reset()
reply(status=301, headers=[("Location", "https://hooks.example.net/next")], body=b"")
out, raised = call()
check("still one connection", len(DIALLED) == 1)
check("...but the report says that one could be asked for directly", "IS an allowed host" in out, out)

print("\nand a redirect to a private address is not followed either")
reset()
reply(status=307, headers=[("Location", "http://169.254.169.254/latest/meta-data/")], body=b"")
out, raised = call()
check("one connection, to the allowed host only", len(DIALLED) == 1)
check("...and the metadata endpoint is named as refused", "only https is allowed" in out or "would be refused" in out, out)

# --- what comes back ----------------------------------------------------------------------------------

print("\ncredentials are stripped out of the response before it reaches the trace")
reset()
reply(
    headers=[
        ("Content-Type", "application/json"),
        ("Set-Cookie", "session=super-secret-value"),
        ("Authorization", "Bearer leaked-token"),
        ("X-RateLimit-Remaining", "42"),
    ],
    body=b"{}",
)
out, raised = call()
check("Set-Cookie is gone", "super-secret-value" not in out and "Set-Cookie" not in out, out)
check("...and Authorization", "leaked-token" not in out)
check("...while the headers an agent needs survive", "X-RateLimit-Remaining: 42" in out)
check("...including the content type", "application/json" in out)

print("\nand a server cannot push those headers out of view behind forty of its own")
reset()
noise = [(f"X-Pad-{i}", "x") for i in range(hc.MAX_RESPONSE_HEADERS + 10)]
reply(headers=[*noise, ("Set-Cookie", "session=super-secret-value")], body=b"{}")
out, raised = call()
check("the cookie is still stripped past the cap", "super-secret-value" not in out)
check("...and the cap is reported rather than silently applied", "further headers omitted" in out)

print("\nthe body is capped at 256 KB")


def body_of(rendered: str) -> str:
    """The response body out of the rendered block — the headers are separated by a blank line.

    Split rather than counted, because the first version of this counted a character and the
    server's own `Date: ... Aug ...` header contributed one. An assertion that reads the wrong
    part of the output is an assertion that passes for the wrong reason just as easily.
    """
    return rendered.split("\n\n", 1)[1].split("\n(response truncated")[0]


reset()
reply(body=b"A" * (hc.MAX_BODY_BYTES + 500))
out, raised = call()
check("the cap is the template's, not the server's", len(body_of(out)) == hc.MAX_BODY_BYTES, str(len(body_of(out))))
check("...and it says it was cut, so the model does not answer from half a document", "response truncated" in out)

reset()
reply(body=b"B" * hc.MAX_BODY_BYTES)
out, raised = call()
check("a body exactly at the cap is not reported as truncated", "response truncated" not in out)
check("...and arrives whole", len(body_of(out)) == hc.MAX_BODY_BYTES)

# --- timeouts ------------------------------------------------------------------------------------------

print("\nthe timeout is the template's ceiling, whatever the caller asks for")
reset()
out, raised = call(timeout=999)
check("a caller cannot argue past thirty seconds", DIALLED[0][2] == hc.MAX_TIMEOUT_S, str(DIALLED))
reset()
out, raised = call(timeout=0)
# Zero is ABSENT, not "no timeout" — the same `x or DEFAULT` idiom every other template in this
# directory uses for an omitted numeric argument. The distinction matters here more than it does
# for a row count: read as "no timeout", a zero would be a socket a hung server holds open for as
# long as it likes, inside a run that is paying for the wait.
check("zero means the caller gave none, so it is the default", DIALLED[0][2] == hc.DEFAULT_TIMEOUT_S, str(DIALLED))
reset()
out, raised = call(timeout=-5)
check("...and a negative one is floored at a second rather than passed on", DIALLED[0][2] == 1, str(DIALLED))

print("\nand a server that does not answer in time raises rather than hanging")
reset()
reply(delay=2.5)
started = time.monotonic()
out, raised = call(timeout=1)
took = time.monotonic() - started
check("it raises", raised.startswith("RuntimeError"), raised)
check("...saying it timed out", "timed out" in raised, raised)
check("...and it really did give up early", took < 2.4, f"{took:.1f}s")
reply()

# --- headers on the way out ------------------------------------------------------------------------------

print("\nthe default auth header is sent and is never spoken about")
reset()
configure(auth="Bearer sk-live-do-not-log")
out, raised = call()
check("it reaches the server as Authorization", RECEIVED[0]["headers"].get("authorization") == "Bearer sk-live-do-not-log")
check("...and never appears in the result", "sk-live-do-not-log" not in out)

reset()
configure(auth="X-Api-Key: sk-live-do-not-log")
out, raised = call()
check("the full-line form becomes the header it names", RECEIVED[0]["headers"].get("x-api-key") == "sk-live-do-not-log")
check("...and no Authorization is invented", "authorization" not in RECEIVED[0]["headers"])

reset()
configure(auth="Bearer sk-live-do-not-log")
out, raised = call(url="https://evil.example/x")
check("a refusal for a disallowed host carries no credential either", "sk-live" not in raised, raised)
configure()

print("\nand a caller cannot set the headers this tool computes")
for line, why in [
    ("Host: evil.example", "Host, which would reach another vhost at the pinned address"),
    ("X-Fine: 1\nHost: evil.example", "...even on a second line"),
    ("Content-Length: 0", "Content-Length, because two disagreeing copies is request smuggling"),
    ("Transfer-Encoding: chunked", "Transfer-Encoding, for the same reason"),
]:
    reset()
    out, raised = call(headers=line)
    check(f"it refuses {why}", "cannot be overridden" in raised, raised)
    check("...with nothing dialled", len(DIALLED) == 0)

reset()
out, raised = call(headers="not a header line")
check("a malformed header line is refused rather than sent", "is not a `Name: value` header line" in raised, raised)

print("\nand a method it does not send is an answer, not a call")
reset()
out, raised = call(method="TRACE")
check("TRACE is refused", "is not a method this tool sends" in out, out)
check("...with nothing dialled", len(DIALLED) == 0)

# --- the allowlist parser, which the connections panel shares ---------------------------------------------

print("\nthe allowlist parser and the panel that validates it agree, because they are the same function")
for good in ["api.example.com", "HOOKS.Example.NET", "a.b.c.example.com", "xn--80ak6aa92e.com"]:
    check(f"{good!r} is a domain", hc.normalise_domain(good) is not None)
for bad in ["*.example.com", "https://api.example.com", "api.example.com/path", "api.example.com:443", "localhost", "", "  ", "a..b.com", "user@example.com"]:
    check(f"{bad!r} is not", hc.normalise_domain(bad) is None, str(hc.normalise_domain(bad)))

check("an empty list is a problem the panel can render", "empty allowlist" in (hc.allowed_domains_problem("") or ""))
check("...and so is a wildcard", "no wildcards" in (hc.allowed_domains_problem("*.example.com") or ""))
check("...and a good list is not a problem", hc.allowed_domains_problem("api.example.com, hooks.example.net") is None)
check("unicode and punycode are the same domain", hc.normalise_domain("münchen.example") == hc.normalise_domain("xn--mnchen-3ya.example"))

server.shutdown()
print("\nALL CORRECT" if failures == 0 else f"\n{failures} FAILURES")
sys.exit(0 if failures == 0 else 1)
