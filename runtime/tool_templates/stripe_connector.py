"""Stripe connector — a read-only lens onto customers, payments, invoices and balances.

Reviewed template. Copied byte-for-byte into generated projects; the builder model is shown
only the signatures and may not rewrite it.

Auth: a secret key, in one variable, exactly as Slack's bot token is. There is no consent screen
for "the Stripe account behind this key", so this is a `user_secret`: the workspace supplies it,
the vault holds it, and one run at a time receives it.

    STRIPE_SECRET_KEY    a RESTRICTED key with read permissions and nothing else

READ-ONLY, ENFORCED TWICE, WHICH IS THE POSTGRES POSTURE APPLIED TO AN API INSTEAD OF A DIALECT.

  1. THIS FILE CALLS `retrieve`, `list` AND `search` AND NOTHING ELSE. There is no `create`, no
     `modify`, no `cancel`, no `refund`, no `capture`, no `delete` — not commented out, not
     behind a flag, not reachable by an argument. The suite scans this source for any other
     method name, so the enforcement is a property of the file rather than of somebody's care.

  2. THE KEY ITSELF CANNOT MUTATE. Stripe's restricted keys carry per-resource permissions, and
     the catalog description, the generation prompt and the connections panel all say to create
     one with read access only. Layer 1 is ours and layer 2 is Stripe's, and the reason both
     exist is the reason Postgres has both: layer 1 fails fast with a message an agent can act
     on, and layer 2 is what holds if layer 1 is ever wrong.

Layer 2 is the real guarantee, and it is the one this template cannot enforce — which is why the
instruction to use a restricted key is repeated in every place a person might read it rather than
only here.

WHAT COMES BACK IS AN ALLOWLIST, NOT THE OBJECT. Every tool below names the fields it returns.
That is deliberately the harder direction to write: a denylist — "everything except the card
number" — is shorter and is wrong the first time Stripe adds a field, because a field added
after this file was written is admitted by a rule that only knows what to remove. An allowlist is
wrong in the safe direction: a new field is invisible until somebody adds it here on purpose.

AND NOTHING IS EXPANDED. Stripe redacts card and bank numbers by default and will hand over more
detail to a request that asks — `expand=["payment_method"]`, `expand=["sources"]`. No tool here
asks. What runs against these results is model-written Python responding to a stranger's prompt,
and the trace stores what it returns; a PAN reaching either is not a thing to be careful about,
it is a thing to be unable to do.

Environment:
    STRIPE_SECRET_KEY

A tool that could not do its job raises. It does not return the reason as if it were an answer.

ONE DEVIATION FROM THE CONNECTOR SPECIFICATION, RECORDED RATHER THAN HIDDEN. That document asks
for a `StripeError` to be caught and "returned as a structured error dict the trace can display,
never a raw exception". The second half is honoured — nothing here lets a raw exception out, and
every message is composed in this file. The first half is not, and cannot be: LangChain records a
RETURNED value as a successful tool call, so a returned error dict produces a green step in the
trace whose content happens to be a failure, and a model handed a normal-looking tool result
answers the user out of it. That is the precise defect this codebase already shipped once with
"Gmail is not configured", and `check_failures_raise()` exists to stop it coming back. So a
Stripe failure raises RuntimeError carrying the error's type and message — the step goes red, and
ToolNode still hands the model the same text as an error-flagged ToolMessage. Nothing is hidden
from either.

Returning is still right for "the tool ran and the answer is empty" — no customer matched, no
payments on this account. That is a result, not a failure.
"""

from __future__ import annotations

import os

from langchain_core.tools import tool

REQUIRED_ENV = ["STRIPE_SECRET_KEY"]

# Stripe's own default is 10 and its own ceiling is 100. Both are repeated here rather than left
# implicit, because what bounds the payload is this number and not Stripe's: a caller asking for
# 500 gets 100 and should be told so rather than left to assume it saw everything.
DEFAULT_LIMIT = 10
MAX_LIMIT = 100
# One invoice can have hundreds of lines — a metered subscription bills per unit — and all of
# them arrive inlined on the object this template already has. The cap is on what is RENDERED,
# so it costs nothing to apply and bounds a payload that would otherwise be a whole month of
# usage in a context window.
MAX_LINE_ITEMS = 25

_MISSING_DEPS = (
    "The Stripe connector needs the 'stripe' package. Install the connector extras: "
    "uv sync --extra connectors"
)


def _sdk():
    """The configured Stripe SDK, or RuntimeError with an actionable message.

    The key is set on the module at call time rather than at import. Import-time configuration
    would read the environment once, in whatever order Python happened to import things, and a
    hosted run assembles its environment after the process is already alive.
    """
    key = os.environ.get("STRIPE_SECRET_KEY")
    if not key:
        raise RuntimeError(
            "Stripe is not configured: STRIPE_SECRET_KEY is not set in the environment. Add a "
            "Stripe RESTRICTED key with read-only permissions in Jaroku's Connections tab, or "
            "put it in runtime/.env."
        )
    try:
        import stripe
    except ImportError as exc:
        raise RuntimeError(_MISSING_DEPS) from exc
    stripe.api_key = key
    return stripe


def _error_type(sdk) -> type[BaseException]:
    """Stripe's own error base, wherever this version of the SDK keeps it.

    It moved: `stripe.error.StripeError` in the 5.x line, `stripe.StripeError` from 7 onwards,
    with the old path kept as an alias for a while and then not. Reading it off the module means
    the template does not have to care which it got, and — the part that matters — a version that
    has neither falls back to `Exception` rather than raising AttributeError from inside the
    handler that exists to make failures legible.
    """
    found = getattr(sdk, "StripeError", None)
    if found is None:
        found = getattr(getattr(sdk, "error", None), "StripeError", None)
    return found if isinstance(found, type) else Exception


def _stripe_fail(what: str, exc: BaseException) -> RuntimeError:
    """A Stripe error, with the fields that make it actionable, and none that identify a card.

    This is the "structured" half of the specification's request, kept while the "return it"
    half is refused — see the header. A `StripeError` carries more than its message: `code` is
    the machine-readable reason (`resource_missing`, `rate_limit`), `param` names the argument
    that was wrong, and `http_status` separates "you asked for something that is not there" from
    "Stripe is having an afternoon". An agent can act on the first three; only the last is worth
    a retry. `user_message` is Stripe's own customer-facing sentence and is included when it
    exists, because it is written for exactly the person who is about to be told.

    `param` is a field NAME, never a value — so nothing assembled here can carry a card number,
    an address or an email.
    """
    parts = [f"{type(exc).__name__}: {exc}"]
    for field in ["code", "param", "http_status"]:
        value = getattr(exc, field, None)
        if value not in (None, ""):
            parts.append(f"{field}={value}")
    user_message = getattr(exc, "user_message", None)
    if user_message:
        parts.append(f"user_message={user_message}")
    return RuntimeError(f"{what} failed: " + " | ".join(parts))


def _fail(what: str, exc: BaseException) -> RuntimeError:
    """Anything that is not a Stripe error: a socket, a JSON body, a version mismatch."""
    return RuntimeError(f"{what} failed: {type(exc).__name__}: {exc}")


def _get(obj: object, key: str) -> object:
    """One field off a Stripe object, which is dict-like but is not a dict."""
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def _pick(obj: object, fields: list[str]) -> dict:
    """Exactly the named fields, and never anything else. See the header on why this is an
    allowlist. Absent fields are dropped rather than rendered as None, so a line in the output
    means Stripe actually had a value."""
    out: dict = {}
    for field in fields:
        value = _get(obj, field)
        if value is not None and value != "":
            out[field] = value
    return out


def _money(amount: object, currency: object) -> str:
    """An amount as Stripe means it, which is not a number of dollars.

    Stripe reports the SMALLEST CURRENCY UNIT — 1999 for $19.99 — except in the zero-decimal
    currencies, where 1999 is ¥1999. Dividing by a hundred is therefore right for most of the
    world and wrong by a factor of a hundred for Japan, Korea and a dozen others, in a number an
    agent is about to quote to a customer. So the integer is reported as the integer, with its
    currency and a note of the unit, and the conversion is left to something that knows the list.
    """
    if amount is None:
        return ""
    code = str(currency).upper() if currency else "?"
    return f"{amount} {code} (minor units)"


def _line(prefix: str, fields: dict) -> str:
    return f"{prefix}\n" + "\n".join(f"  {k}: {v}" for k, v in fields.items())


CUSTOMER_FIELDS = ["id", "email", "name", "created", "description", "currency", "metadata"]
PAYMENT_FIELDS = ["id", "status", "created", "description", "customer", "payment_method_types"]
INVOICE_FIELDS = ["id", "status", "created", "due_date", "customer", "number", "hosted_invoice_url"]


@tool
def stripe_get_customer(customer_id: str = "", email: str = "") -> str:
    """Look up one Stripe customer, by id or by email address. Read-only.

    Pass `customer_id` when you have one (`cus_...`), or `email` to search for it. Returns the
    customer's id, email, name, creation time and metadata. It never returns payment methods,
    card numbers or bank details.
    """
    wanted_id = customer_id.strip()
    wanted_email = email.strip()
    if not wanted_id and not wanted_email:
        return "Cannot look up a customer: pass either `customer_id` or `email`."

    sdk = _sdk()
    try:
        if wanted_id:
            customer = sdk.Customer.retrieve(wanted_id)
            return _line(f"Customer {wanted_id}:", _pick(customer, CUSTOMER_FIELDS))

        # SEARCH RATHER THAN `list(email=...)`, and the quoting is the reason to look twice.
        # Stripe's search query language is a string, so an email containing a quote would end
        # the literal and change the query — the same shape of hole an f-string in SQL is. The
        # quote is escaped rather than the value rejected, because apostrophes in an address are
        # rare, legal, and somebody's actual account.
        safe = wanted_email.replace("\\", "\\\\").replace("'", "\\'")
        found = sdk.Customer.search(query=f"email:'{safe}'", limit=MAX_LIMIT)
        rows = list(_get(found, "data") or [])
        if not rows:
            return f"No Stripe customer has the email {wanted_email!r}."
        return f"{len(rows)} customer(s) with email {wanted_email!r}:\n" + "\n".join(
            _line(f"- {_get(r, 'id')}", _pick(r, CUSTOMER_FIELDS)) for r in rows
        )
    except RuntimeError:
        raise  # not configured, or a missing dependency — a failure, not an answer
    except _error_type(sdk) as exc:
        raise _stripe_fail("The Stripe lookup", exc) from exc
    except Exception as exc:
        raise _fail("The Stripe lookup", exc) from exc


@tool
def stripe_list_payments(customer_id: str, limit: int = DEFAULT_LIMIT) -> str:
    """List a Stripe customer's recent payment intents, newest first. Read-only.

    `customer_id` is a `cus_...` id. Returns each payment's id, amount, currency, status,
    creation time and description, capped at 100.
    """
    wanted = customer_id.strip()
    if not wanted:
        return "Cannot list payments: `customer_id` is empty."
    limit = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))

    sdk = _sdk()
    try:
        listing = sdk.PaymentIntent.list(customer=wanted, limit=limit)
        rows = list(_get(listing, "data") or [])
        if not rows:
            return f"No payments for customer {wanted!r}."
        lines = [
            _line(
                f"- {_get(r, 'id')}  {_money(_get(r, 'amount'), _get(r, 'currency'))}",
                _pick(r, PAYMENT_FIELDS),
            )
            for r in rows
        ]
        note = f"\n({limit} cap reached — there may be more)" if len(lines) == limit else ""
        return f"{len(lines)} payment(s) for {wanted!r}:\n" + "\n".join(lines) + note
    except RuntimeError:
        raise
    except _error_type(sdk) as exc:
        raise _stripe_fail(f"Listing payments for {wanted!r}", exc) from exc
    except Exception as exc:
        raise _fail(f"Listing payments for {wanted!r}", exc) from exc


@tool
def stripe_get_payment(payment_intent_id: str) -> str:
    """Get one Stripe payment intent by id. Read-only.

    `payment_intent_id` is a `pi_...` id. Returns its amount, currency, status, description and
    why it failed if it did — never the card or bank details behind it.
    """
    wanted = payment_intent_id.strip()
    if not wanted:
        return "Cannot fetch a payment: `payment_intent_id` is empty."

    sdk = _sdk()
    try:
        payment = sdk.PaymentIntent.retrieve(wanted)
        fields = _pick(payment, [*PAYMENT_FIELDS, "amount_received", "canceled_at", "capture_method"])
        fields["amount"] = _money(_get(payment, "amount"), _get(payment, "currency"))
        # The one nested field worth reaching into: why it failed. Its `message` is Stripe's own
        # customer-facing sentence, which is the thing an agent is being asked about. The rest of
        # `last_payment_error` carries the payment method that failed, and is left alone.
        last_error = _get(payment, "last_payment_error")
        if last_error is not None:
            message = _get(last_error, "message")
            if message:
                fields["last_payment_error"] = message
        return _line(f"Payment {wanted}:", fields)
    except RuntimeError:
        raise
    except _error_type(sdk) as exc:
        raise _stripe_fail(f"Fetching payment {wanted!r}", exc) from exc
    except Exception as exc:
        raise _fail(f"Fetching payment {wanted!r}", exc) from exc


@tool
def stripe_list_invoices(customer_id: str, limit: int = DEFAULT_LIMIT) -> str:
    """List a Stripe customer's invoices, newest first. Read-only.

    `customer_id` is a `cus_...` id. Returns each invoice's id, number, status, amount due,
    amount paid, creation time and due date, capped at 100.
    """
    wanted = customer_id.strip()
    if not wanted:
        return "Cannot list invoices: `customer_id` is empty."
    limit = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))

    sdk = _sdk()
    try:
        listing = sdk.Invoice.list(customer=wanted, limit=limit)
        rows = list(_get(listing, "data") or [])
        if not rows:
            return f"No invoices for customer {wanted!r}."
        lines = []
        for r in rows:
            fields = _pick(r, INVOICE_FIELDS)
            currency = _get(r, "currency")
            fields["amount_due"] = _money(_get(r, "amount_due"), currency)
            fields["amount_paid"] = _money(_get(r, "amount_paid"), currency)
            lines.append(_line(f"- {_get(r, 'id')}", fields))
        note = f"\n({limit} cap reached — there may be more)" if len(lines) == limit else ""
        return f"{len(lines)} invoice(s) for {wanted!r}:\n" + "\n".join(lines) + note
    except RuntimeError:
        raise
    except _error_type(sdk) as exc:
        raise _stripe_fail(f"Listing invoices for {wanted!r}", exc) from exc
    except Exception as exc:
        raise _fail(f"Listing invoices for {wanted!r}", exc) from exc


@tool
def stripe_get_invoice(invoice_id: str) -> str:
    """Get one Stripe invoice by id, with what it is for. Read-only.

    `invoice_id` is an `in_...` id. Returns the invoice's status and amounts and a summary of its
    line items. It never returns the customer's billing address, tax ids or payment method.
    """
    wanted = invoice_id.strip()
    if not wanted:
        return "Cannot fetch an invoice: `invoice_id` is empty."

    sdk = _sdk()
    try:
        invoice = sdk.Invoice.retrieve(wanted)
        currency = _get(invoice, "currency")
        fields = _pick(invoice, [*INVOICE_FIELDS, "paid", "attempt_count", "period_start", "period_end"])
        fields["amount_due"] = _money(_get(invoice, "amount_due"), currency)
        fields["amount_paid"] = _money(_get(invoice, "amount_paid"), currency)
        fields["amount_remaining"] = _money(_get(invoice, "amount_remaining"), currency)

        # THE LINE ITEMS ARE WHAT MAKES AN INVOICE ANSWERABLE — "what was I charged for" is the
        # question a support agent is holding — so three fields of each are read, by name, from
        # the object already in hand. `lines` on a retrieved invoice is a paginated list Stripe
        # has already inlined; nothing here fetches more of it, which is both the cap and the
        # reason no second call can widen what this tool returns.
        raw_lines = list(_get(_get(invoice, "lines"), "data") or [])
        shown = []
        for item in raw_lines[:MAX_LINE_ITEMS]:
            description = _get(item, "description") or "(no description)"
            quantity = _get(item, "quantity")
            amount = _money(_get(item, "amount"), _get(item, "currency") or currency)
            shown.append(f"    - {description}{f' ×{quantity}' if quantity else ''}  {amount}")
        body = _line(f"Invoice {wanted}:", fields)
        if shown:
            extra = len(raw_lines) - len(shown)
            body += "\n  line items:\n" + "\n".join(shown)
            if extra > 0:
                body += f"\n    (+{extra} more)"
        return body
    except RuntimeError:
        raise
    except _error_type(sdk) as exc:
        raise _stripe_fail(f"Fetching invoice {wanted!r}", exc) from exc
    except Exception as exc:
        raise _fail(f"Fetching invoice {wanted!r}", exc) from exc


@tool
def stripe_get_balance() -> str:
    """Get the Stripe account's balance: what is available now and what is still pending.

    Takes no arguments. Both figures are per-currency and in the smallest currency unit.
    """
    sdk = _sdk()
    try:
        balance = sdk.Balance.retrieve()

        def band(name: str) -> str:
            # `available` and `pending` are LISTS, one entry per currency, and an account that has
            # ever taken a payment in two currencies has two entries. Reading `[0]` — which is
            # what a reader who saw one entry writes — reports one currency's figure as the
            # account's balance, which is a wrong number that looks exactly like a right one.
            entries = list(_get(balance, name) or [])
            if not entries:
                return f"  {name}: none"
            return f"  {name}: " + ", ".join(
                _money(_get(e, "amount"), _get(e, "currency")) for e in entries
            )

        return "Stripe account balance:\n" + band("available") + "\n" + band("pending")
    except RuntimeError:
        raise
    except _error_type(sdk) as exc:
        raise _stripe_fail("Fetching the Stripe balance", exc) from exc
    except Exception as exc:
        raise _fail("Fetching the Stripe balance", exc) from exc


TEMPLATE_TOOLS = [
    stripe_get_customer,
    stripe_list_payments,
    stripe_get_payment,
    stripe_list_invoices,
    stripe_get_invoice,
    stripe_get_balance,
]
