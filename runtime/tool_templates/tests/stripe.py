"""The Stripe connector, and the one assertion that is about the file rather than the behaviour.

READ-ONLY IS CHECKED BY READING THE SOURCE, NOT BY TRYING TO MUTATE. Every other property here
can be tested by calling a tool and looking at what came back. "This connector cannot charge
anybody" cannot: the way it stops being true is a seventh tool, or a fourth branch in an existing
one, and neither exists to be called until somebody has already written it. So the enforcement is
a scan — every call the template makes on the Stripe SDK is found in its own syntax tree, and its
method name must be `retrieve`, `list` or `search`. A `create`, a `modify`, a `cancel` or a
`refund` fails here at the moment it is added rather than at the moment it is invoked, which for
this connector is the moment somebody's money moves.

A TEXT SCAN ALONE WOULD NOT DO, WHICH IS WHY THIS ONE IS AN AST. `# stripe.Refund.create(...)` in
a comment fails a substring search and is harmless; `getattr(sdk.Refund, verb)(...)` passes one
and is the whole vulnerability. The tree sees the first as a comment and the second as a call it
cannot prove is safe. Both text and tree checks are run, in that order, because the text one
produces the better message when it is the one that fires.

THE ERROR ASSERTIONS ARE THE SPECIFICATION'S OTHER HALF, HELD THE OTHER WAY UP. It asks for a
StripeError to be caught and RETURNED as a structured dict. It is caught and its structure is
kept — code, param, http_status, user_message — and then it is RAISED, because LangChain records
a returned value as a successful call and a green step over a failed payment lookup is the exact
defect `check_failures_raise()` exists to prevent. So the suite asserts all six raise, and that
the structure survives into the message.

  npm run test:connector-stripe
"""

from __future__ import annotations

import ast
import os
import pathlib
import sys
import types

failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    if ok:
        print(f"  ok   {name}")
    else:
        failures += 1
        print(f"  FAIL {name}{f' — {detail}' if detail else ''}")


# --- the fake Stripe ----------------------------------------------------------------------

calls: list[tuple[str, str, dict]] = []
script: dict[str, object] = {}
raise_next: list[BaseException] = []


class FakeStripeError(Exception):
    """Shaped like the real one: a message plus the four fields that make it actionable."""

    def __init__(self, message: str, code=None, param=None, http_status=None, user_message=None) -> None:
        super().__init__(message)
        self.code = code
        self.param = param
        self.http_status = http_status
        self.user_message = user_message


def _resource(name: str):
    class Resource:
        @staticmethod
        def _call(verb: str, kwargs: dict) -> object:
            calls.append((name, verb, kwargs))
            if raise_next:
                raise raise_next.pop(0)
            return script.get(f"{name}.{verb}", {})

        @classmethod
        def retrieve(cls, *args: object, **kwargs: object) -> object:
            return cls._call("retrieve", {"id": args[0] if args else None, **kwargs})

        @classmethod
        def list(cls, **kwargs: object) -> object:
            return cls._call("list", kwargs)

        @classmethod
        def search(cls, **kwargs: object) -> object:
            return cls._call("search", kwargs)

    Resource.__name__ = name
    return Resource


class _Blocked:
    def __init__(self, names: set[str]) -> None:
        self.names = names

    def find_module(self, fullname: str, path: object = None) -> object:  # pragma: no cover
        return self.find_spec(fullname, path)

    def find_spec(self, fullname: str, path: object = None, target: object = None) -> object:
        if fullname.split(".", 1)[0] in self.names:
            raise ImportError(f"blocked by the suite: {fullname}")
        return None


def install_sdk() -> types.ModuleType:
    sys.meta_path = [m for m in sys.meta_path if not isinstance(m, _Blocked)]
    fake = types.ModuleType("stripe")
    fake.api_key = None  # type: ignore[attr-defined]
    fake.StripeError = FakeStripeError  # type: ignore[attr-defined]
    for name in ["Customer", "PaymentIntent", "Invoice", "Balance"]:
        setattr(fake, name, _resource(name))
    sys.modules["stripe"] = fake
    return fake


def remove_sdk() -> None:
    sys.modules.pop("stripe", None)
    sys.meta_path.insert(0, _Blocked({"stripe"}))


def reset() -> None:
    calls.clear()
    script.clear()
    raise_next.clear()


sdk = install_sdk()
os.environ["STRIPE_SECRET_KEY"] = "rk_test_restricted_read_only"

from .. import stripe_connector as sc  # noqa: E402  — after the fake is in sys.modules

SOURCE = pathlib.Path(sc.__file__).read_text(encoding="utf-8")

# --- read-only, as a property of the file ---------------------------------------------------

print("\nthe template calls three methods on Stripe and no others")
ALLOWED = {"retrieve", "list", "search"}
tree = ast.parse(SOURCE)


def root_of(node: ast.AST) -> str | None:
    """The name at the bottom of an attribute chain: sdk.Customer.retrieve -> 'sdk'."""
    while isinstance(node, ast.Attribute):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


offending: list[str] = []
sdk_calls: list[str] = []
for node in ast.walk(tree):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        if root_of(node.func) in {"sdk", "stripe"}:
            sdk_calls.append(node.func.attr)
            if node.func.attr not in ALLOWED:
                offending.append(f"line {node.lineno}: .{node.func.attr}()")

check("every SDK call is retrieve, list or search", not offending, "; ".join(offending))
check("...and there are some, so the scan had something to scan", len(sdk_calls) >= 6, str(len(sdk_calls)))


def code_only(module: ast.Module) -> str:
    """The template's CODE, with its prose removed.

    THE TEXT PASS BELOW RUNS OVER THIS RATHER THAN OVER THE FILE, and the reason is the header
    of the template itself: it explains the posture by NAMING what it does not do — "no `create`,
    no `modify`, no `refund`", "`expand=["payment_method"]`. No tool here asks." A substring scan
    over the raw file fails on every one of those sentences, which would leave the connector
    unable to document its own safety property without breaking the check that enforces it. So
    docstrings come out and comments never survive `unparse`, and what is scanned is what runs.
    """
    stripped = ast.parse(ast.unparse(module))
    for node in ast.walk(stripped):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
                node.body = body[1:] or [ast.Pass()]
    return ast.unparse(stripped)


CODE = code_only(tree)

# The text pass. Second in code and first in spirit: when IT is the one that fires, the message
# names the thing somebody wrote rather than a line number.
for forbidden in ["create(", "modify(", "delete(", "cancel(", "capture(", ".save(", "Refund", "expand="]:
    check(f"the code contains no {forbidden!r}", forbidden not in CODE)
check("and the scan really did drop the prose that names them", "no `create`" in SOURCE and "no `create`" not in CODE)

print("\nand nothing but the api key is ever set on the SDK")
assigned = [
    t.attr
    for node in ast.walk(tree)
    if isinstance(node, ast.Assign)
    for t in node.targets
    if isinstance(t, ast.Attribute) and root_of(t) in {"sdk", "stripe"}
]
check("only api_key is assigned", set(assigned) <= {"api_key"}, ", ".join(assigned))

print("\nand a getattr-shaped escape hatch is not hiding in it")


def is_sdk_getattr(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "getattr"
        and any(root_of(a) in {"sdk", "stripe"} for a in node.args if isinstance(a, (ast.Name, ast.Attribute)))
    )


# TWO SHAPES ARE REFUSED AND A THIRD IS ALLOWED, which is the whole subtlety of this check.
# `getattr(sdk.Refund, verb)(...)` is the escape hatch — a call assembled at runtime, invisible
# to a substring scan, and able to reach any method Stripe has. `getattr(sdk, name)` with a
# computed name is the same hole one level up. But `getattr(sdk, "StripeError", None)` is a
# LITERAL read of an error class that is never invoked, and the template needs it because Stripe
# moved that class between major versions. A rule that refused all three would force the error
# handling to guess which SDK it got.
invoked = [n.lineno for n in ast.walk(tree) if isinstance(n, ast.Call) and is_sdk_getattr(n.func)]
computed = [
    n.lineno
    for n in ast.walk(tree)
    if is_sdk_getattr(n)
    and not (len(n.args) >= 2 and isinstance(n.args[1], ast.Constant) and isinstance(n.args[1].value, str))
]
check("no getattr against the SDK is ever called, which a text scan could not have seen", not invoked, str(invoked))
check("...and none of them names its attribute at runtime", not computed, str(computed))

print("\nand the scanner can fail, which is the only thing that makes it worth running")
# A CHECK NOBODY HAS SEEN REFUSE ANYTHING IS A CHECK THAT MIGHT BE STUCK AT TRUE. Every rule
# above passes on the current file, so each is re-run against a snippet that violates it and
# asserted to fire. Without this, a scan whose root_of() quietly returned None for every node
# would report a clean bill of health over a template full of refunds.
def scan(snippet: str) -> tuple[list[str], list[int], list[int]]:
    t = ast.parse(snippet)
    bad = [
        f".{n.func.attr}()"
        for n in ast.walk(t)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
        and root_of(n.func) in {"sdk", "stripe"} and n.func.attr not in ALLOWED
    ]
    called = [n.lineno for n in ast.walk(t) if isinstance(n, ast.Call) and is_sdk_getattr(n.func)]
    dynamic = [
        n.lineno
        for n in ast.walk(t)
        if is_sdk_getattr(n)
        and not (len(n.args) >= 2 and isinstance(n.args[1], ast.Constant) and isinstance(n.args[1].value, str))
    ]
    return bad, called, dynamic


check("a refund is caught", scan("sdk.Refund.create(charge='ch_1')")[0] == [".create()"])
check("...and so is a cancellation on a resource that also has legal reads", scan("sdk.PaymentIntent.cancel('pi_1')")[0] == [".cancel()"])
check("a runtime-assembled call is caught", scan("getattr(sdk.Refund, verb)(charge='ch_1')")[1] == [1])
check("...and a computed attribute name is caught", scan("x = getattr(sdk, name, None)")[2] == [1])
check("and a legal read still passes all three", scan("e = getattr(sdk, 'StripeError', None)\nsdk.Customer.retrieve('cus_1')") == ([], [], []))

# --- customers ------------------------------------------------------------------------------

print("\na customer, by id and by email")
reset()
script["Customer.retrieve"] = {"id": "cus_1", "email": "ada@example.com", "name": "Ada", "created": 1740000000}
out = sc.stripe_get_customer.invoke({"customer_id": "cus_1"})
check("it retrieves the id it was given", calls[0][:2] == ("Customer", "retrieve") and calls[0][2]["id"] == "cus_1")
check("and reports the fields it names", "ada@example.com" in out and "Ada" in out)

reset()
script["Customer.search"] = {"data": [{"id": "cus_1", "email": "ada@example.com"}]}
out = sc.stripe_get_customer.invoke({"email": "ada@example.com"})
check("an email goes through search", calls[0][:2] == ("Customer", "search"))
check("...with the email in the query literal", calls[0][2]["query"] == "email:'ada@example.com'")
check("...and the match comes back", "cus_1" in out)

reset()
script["Customer.search"] = {"data": []}
check("no match is an answer, not a failure", "No Stripe customer" in sc.stripe_get_customer.invoke({"email": "nobody@example.com"}))

print("\nand a quote in an address cannot end the query it is inside")
reset()
script["Customer.search"] = {"data": []}
sc.stripe_get_customer.invoke({"email": "o'brien@example.com"})
check("the apostrophe is escaped rather than the person refused", calls[0][2]["query"] == "email:'o\\'brien@example.com'")
reset()
script["Customer.search"] = {"data": []}
sc.stripe_get_customer.invoke({"email": "x' OR status:'active"})
check("...and an injected clause stays inside the literal", calls[0][2]["query"] == "email:'x\\' OR status:\\'active'")

reset()
check("neither argument is an answer, not a call", "pass either" in sc.stripe_get_customer.invoke({}))
check("...and it really did not call", len(calls) == 0)

# --- the allowlist ---------------------------------------------------------------------------

print("\nwhat comes back is the allowlist, whatever Stripe sends")
reset()
script["Customer.retrieve"] = {
    "id": "cus_1",
    "email": "ada@example.com",
    "sources": {"data": [{"last4": "4242", "exp_year": 2030}]},
    "default_source": "card_1",
    "invoice_settings": {"default_payment_method": "pm_1"},
    "a_field_stripe_added_next_year": "surprise",
}
out = sc.stripe_get_customer.invoke({"customer_id": "cus_1"})
check("the named fields are there", "cus_1" in out and "ada@example.com" in out)
check("a card fragment is not", "4242" not in out)
check("...nor a payment method id", "pm_1" not in out and "card_1" not in out)
check("...nor a field nobody has added to the allowlist yet", "surprise" not in out)

# --- payments --------------------------------------------------------------------------------

print("\npayments, and the cap a caller cannot argue past")
reset()
script["PaymentIntent.list"] = {"data": [{"id": f"pi_{i}", "amount": 1999, "currency": "usd", "status": "succeeded"} for i in range(100)]}
out = sc.stripe_list_payments.invoke({"customer_id": "cus_1", "limit": 500})
check("the request is clamped to Stripe's own ceiling", calls[0][2]["limit"] == sc.MAX_LIMIT)
check("...and says so, so the model does not assume that was all", "cap reached" in out)
check("the customer filter is sent", calls[0][2]["customer"] == "cus_1")

reset()
script["PaymentIntent.list"] = {"data": []}
sc.stripe_list_payments.invoke({"customer_id": "cus_1"})
check("the default is ten", calls[0][2]["limit"] == sc.DEFAULT_LIMIT)
check("an empty id is refused before any call", sc.stripe_list_payments.invoke({"customer_id": " "}).startswith("Cannot list"))

print("\nand an amount is reported in the unit Stripe actually means")
reset()
script["PaymentIntent.list"] = {"data": [{"id": "pi_1", "amount": 1999, "currency": "jpy", "status": "succeeded"}]}
out = sc.stripe_list_payments.invoke({"customer_id": "cus_1"})
check("the integer is not divided by a hundred", "1999 JPY" in out, out)
check("...and the unit is named, because dividing is right for most currencies and not this one", "minor units" in out)

print("\none payment, with why it failed and not what it was paid with")
reset()
script["PaymentIntent.retrieve"] = {
    "id": "pi_1", "amount": 2500, "currency": "gbp", "status": "requires_payment_method",
    "last_payment_error": {"message": "Your card was declined.", "payment_method": {"card": {"last4": "0002"}}},
    "charges": {"data": [{"payment_method_details": {"card": {"last4": "0002"}}}]},
}
out = sc.stripe_get_payment.invoke({"payment_intent_id": "pi_1"})
check("the decline reason is surfaced", "Your card was declined." in out)
check("...and the card behind it is not", "0002" not in out)
check("...and neither is the charge list", "payment_method_details" not in out)

# --- invoices ---------------------------------------------------------------------------------

print("\ninvoices")
reset()
script["Invoice.list"] = {"data": [{"id": "in_1", "status": "paid", "amount_due": 5000, "amount_paid": 5000, "currency": "eur", "number": "A-001"}]}
out = sc.stripe_list_invoices.invoke({"customer_id": "cus_1"})
check("both amounts are reported", out.count("5000 EUR") == 2)
check("...with the invoice number a person would quote", "A-001" in out)

reset()
script["Invoice.retrieve"] = {
    "id": "in_1", "status": "open", "amount_due": 12000, "amount_paid": 0, "amount_remaining": 12000, "currency": "usd",
    "customer_address": {"line1": "1 Example Street"},
    "customer_tax_ids": [{"value": "GB123456789"}],
    "lines": {"data": [{"description": f"Seat {i}", "quantity": 1, "amount": 1000, "currency": "usd"} for i in range(40)]},
}
out = sc.stripe_get_invoice.invoke({"invoice_id": "in_1"})
check("the line items answer 'what was I charged for'", "Seat 0" in out)
check("...capped, with the remainder counted", "(+15 more)" in out, out[-80:])
check("the billing address never appears", "Example Street" not in out)
check("...nor a tax id", "GB123456789" not in out)
check("an empty id is refused before any call", sc.stripe_get_invoice.invoke({"invoice_id": ""}).startswith("Cannot fetch"))

# --- balance -----------------------------------------------------------------------------------

print("\nthe balance is per currency, and reading the first entry would report one as the whole")
reset()
script["Balance.retrieve"] = {
    "available": [{"amount": 10000, "currency": "usd"}, {"amount": 250000, "currency": "jpy"}],
    "pending": [{"amount": 500, "currency": "usd"}],
}
out = sc.stripe_get_balance.invoke({})
check("both available currencies are there", "10000 USD" in out and "250000 JPY" in out)
check("...and pending is its own band", "pending" in out and "500 USD" in out)
check("it takes no arguments at all", sc.stripe_get_balance.args == {}, str(sc.stripe_get_balance.args))

reset()
script["Balance.retrieve"] = {"available": [], "pending": []}
check("an empty balance says none rather than nothing", "none" in sc.stripe_get_balance.invoke({}))

# --- failure ------------------------------------------------------------------------------------

print("\nevery one of the six raises on a Stripe error, and the structure survives into the message")
INVOCATIONS = [
    (sc.stripe_get_customer, {"customer_id": "cus_1"}),
    (sc.stripe_list_payments, {"customer_id": "cus_1"}),
    (sc.stripe_get_payment, {"payment_intent_id": "pi_1"}),
    (sc.stripe_list_invoices, {"customer_id": "cus_1"}),
    (sc.stripe_get_invoice, {"invoice_id": "in_1"}),
    (sc.stripe_get_balance, {}),
]
check("all six tools are covered", len(INVOCATIONS) == len(sc.TEMPLATE_TOOLS))
for tool_fn, args in INVOCATIONS:
    reset()
    raise_next.append(
        FakeStripeError("No such customer", code="resource_missing", param="id", http_status=404, user_message="We could not find that.")
    )
    raised = ""
    try:
        tool_fn.invoke(args)
    except Exception as exc:  # noqa: BLE001 — the type is what is under test
        raised = f"{type(exc).__name__}: {exc}"
    ok = raised.startswith("RuntimeError") and "code=resource_missing" in raised and "http_status=404" in raised
    check(f"{tool_fn.name} raises with its code and status", ok, raised)

reset()
raise_next.append(TimeoutError("connection timed out"))
raised = ""
try:
    sc.stripe_get_balance.invoke({})
except Exception as exc:  # noqa: BLE001
    raised = f"{type(exc).__name__}: {exc}"
check("and a socket failure raises too, rather than escaping raw", raised.startswith("RuntimeError") and "TimeoutError" in raised, raised)

print("\nand a missing key or a missing SDK is a clean failure that names the fix")
reset()
os.environ.pop("STRIPE_SECRET_KEY", None)
raised = ""
try:
    sc.stripe_get_balance.invoke({})
except Exception as exc:  # noqa: BLE001
    raised = str(exc)
check("no key raises", "STRIPE_SECRET_KEY is not set" in raised, raised)
check("...and says to use a restricted key", "RESTRICTED" in raised)
check("...and never quotes a value", "rk_test" not in raised)

os.environ["STRIPE_SECRET_KEY"] = "rk_test_restricted_read_only"
remove_sdk()
raised = ""
try:
    sc.stripe_get_balance.invoke({})
except Exception as exc:  # noqa: BLE001
    raised = str(exc)
check("no SDK raises", "'stripe' package" in raised, raised)
check("...naming the command that installs it", "uv sync --extra connectors" in raised)
install_sdk()

print("\nALL CORRECT" if failures == 0 else f"\n{failures} FAILURES")
sys.exit(0 if failures == 0 else 1)
