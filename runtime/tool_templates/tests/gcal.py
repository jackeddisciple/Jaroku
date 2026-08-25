"""The Google Calendar connector, against a Google that is not there.

WHY A FAKE SDK RATHER THAN A RECORDED RESPONSE. Half of what is worth asserting about this
template is what it SENDS, not what it does with what comes back: that a listing expands
recurring series, that a cap the caller argued past is clamped before the request leaves, that an
update merges onto the current event rather than replacing it. A fixture of Google's replies can
say nothing about any of those. So `googleapiclient.discovery.build` is replaced by something
that records every call and answers from a script, and the assertions are mostly about the
recording.

AND THE SDK IS BLOCKED RATHER THAN MERELY ABSENT. `google-api-python-client` lives in the
`connectors` extra, so on a base install `import googleapiclient` already fails — which would
make the missing-dependency assertion below pass for a reason that has nothing to do with the
code, and quietly stop testing anything on a developer machine that happens to have the extra
installed. A meta-path finder that refuses the name makes the result the same everywhere.

THE CACHE IS THE SUBTLE ONE. `_service()` caches the built client because discovery is a network
call, and a bare module-level cache would outlive the environment it was built from. This repo
has a check that depends on it not doing so — `check_failures_raise()` strips every configuring
variable and asserts each tool then raises — so a service cached from an earlier configured call
would let an unconfigured tool succeed and draw a green step over a broken connector. The suite
does exactly that sequence: configure, call, strip, call again.

  npm run test:connector-gcal
"""

from __future__ import annotations

import os
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


# --- the fake Google ----------------------------------------------------------------------

calls: list[tuple[str, dict]] = []
script: dict[str, object] = {}


class _Executable:
    def __init__(self, result: object) -> None:
        self._result = result

    def execute(self) -> object:
        if isinstance(self._result, Exception):
            raise self._result
        return self._result


class _Events:
    def _record(self, verb: str, kwargs: dict) -> _Executable:
        calls.append((verb, kwargs))
        return _Executable(script.get(verb, {}))

    def list(self, **kwargs: object) -> _Executable:
        return self._record("list", kwargs)

    def get(self, **kwargs: object) -> _Executable:
        return self._record("get", kwargs)

    def insert(self, **kwargs: object) -> _Executable:
        return self._record("insert", kwargs)

    def update(self, **kwargs: object) -> _Executable:
        return self._record("update", kwargs)


class _Service:
    def __init__(self, **kwargs: object) -> None:
        self.built_with = kwargs

    def events(self) -> _Events:
        return _Events()


built: list[dict] = []


def _build(name: str, version: str, **kwargs: object) -> _Service:
    built.append({"name": name, "version": version, **kwargs})
    return _Service(**kwargs)


class _Credentials:
    """Records what the template asked google-auth for, which is the whole of the auth test."""

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs


class _Blocked:
    """Refuses the connector SDK by name, whether or not the extra is installed here."""

    def __init__(self, names: set[str]) -> None:
        self.names = names

    def find_module(self, fullname: str, path: object = None) -> object:  # pragma: no cover
        return self.find_spec(fullname, path)

    def find_spec(self, fullname: str, path: object = None, target: object = None) -> object:
        root = fullname.split(".", 1)[0]
        if root in self.names:
            raise ImportError(f"blocked by the suite: {fullname}")
        return None


def install_sdk() -> None:
    """Put the fakes where the template's lazy imports will find them."""
    sys.meta_path = [m for m in sys.meta_path if not isinstance(m, _Blocked)]

    google = sys.modules.setdefault("google", types.ModuleType("google"))
    oauth2 = types.ModuleType("google.oauth2")
    credentials = types.ModuleType("google.oauth2.credentials")
    credentials.Credentials = _Credentials  # type: ignore[attr-defined]
    oauth2.credentials = credentials  # type: ignore[attr-defined]
    google.oauth2 = oauth2  # type: ignore[attr-defined]
    sys.modules["google.oauth2"] = oauth2
    sys.modules["google.oauth2.credentials"] = credentials

    api = types.ModuleType("googleapiclient")
    discovery = types.ModuleType("googleapiclient.discovery")
    discovery.build = _build  # type: ignore[attr-defined]
    api.discovery = discovery  # type: ignore[attr-defined]
    sys.modules["googleapiclient"] = api
    sys.modules["googleapiclient.discovery"] = discovery


def remove_sdk() -> None:
    """Take it away again, and refuse a real one that happens to be installed."""
    for name in list(sys.modules):
        if name.split(".", 1)[0] in {"googleapiclient"} or name.startswith("google.oauth2"):
            del sys.modules[name]
    sys.meta_path.insert(0, _Blocked({"googleapiclient"}))


def configure(access_token: str | None = "ya29.token", triple: bool = False) -> None:
    for name in ["GCAL_ACCESS_TOKEN", "GCAL_CLIENT_ID", "GCAL_CLIENT_SECRET", "GCAL_REFRESH_TOKEN"]:
        os.environ.pop(name, None)
    if access_token:
        os.environ["GCAL_ACCESS_TOKEN"] = access_token
    if triple:
        os.environ["GCAL_CLIENT_ID"] = "client-id"
        os.environ["GCAL_CLIENT_SECRET"] = "client-secret"
        os.environ["GCAL_REFRESH_TOKEN"] = "1//refresh"


def reset() -> None:
    calls.clear()
    built.clear()
    script.clear()


install_sdk()
configure()

from .. import google_calendar as gcal  # noqa: E402  — after the fakes are in sys.modules


def event(**over: object) -> dict:
    base = {
        "id": "evt-1",
        "summary": "Weekly standup",
        "start": {"dateTime": "2026-03-04T09:00:00Z"},
        "end": {"dateTime": "2026-03-04T09:15:00Z"},
        "status": "confirmed",
        "location": "Room 2",
        "attendees": [{"email": "ada@example.com"}],
    }
    base.update(over)
    return base


# --- listing ------------------------------------------------------------------------------

print("\nlisting asks for the window it was given, and expands what a rule cannot answer")
reset()
script["list"] = {"items": [event(), event(id="evt-2", summary="Retro")]}
out = gcal.gcal_list_events.invoke(
    {"time_min": "2026-03-01T00:00:00Z", "time_max": "2026-03-07T00:00:00Z", "max_results": 5}
)
sent = calls[0][1]
check("the window reaches Google as timeMin and timeMax", sent["timeMin"] == "2026-03-01T00:00:00Z" and sent["timeMax"] == "2026-03-07T00:00:00Z")
check("the default calendar is the primary one", sent["calendarId"] == "primary")
check("recurring series are expanded into instances", sent["singleEvents"] is True)
check("...which is what makes ordering by start time legal", sent["orderBy"] == "startTime")
check("both events come back", "evt-1" in out and "evt-2" in out)
check("with their times", "2026-03-04T09:00:00Z" in out)

print("\nan open-ended window sends no bound rather than an empty one")
reset()
script["list"] = {"items": []}
out = gcal.gcal_list_events.invoke({"time_min": "2026-03-01T00:00:00Z"})
check("timeMin is sent", calls[0][1].get("timeMin") == "2026-03-01T00:00:00Z")
check("...and timeMax is absent rather than empty", "timeMax" not in calls[0][1])
check("an empty window is an answer, not a failure", "No events" in out)

print("\nan all-day event has a date and not a dateTime, and renders as itself")
reset()
script["list"] = {"items": [event(start={"date": "2026-03-05"}, end={"date": "2026-03-06"})]}
out = gcal.gcal_list_events.invoke({})
check("the date is shown", "2026-03-05" in out)

# --- the caps -----------------------------------------------------------------------------

print("\nevery payload is capped before it reaches a context window")
reset()
script["list"] = {"items": [event() for _ in range(80)]}
out = gcal.gcal_list_events.invoke({"max_results": 999})
check("a caller cannot argue past the ceiling", calls[0][1]["maxResults"] == gcal.MAX_RESULTS)
check(
    "...and the answer is clamped to it whatever Google returns",
    out.count("id=evt-1") == gcal.MAX_RESULTS,
    str(out.count("id=evt-1")),
)
check("...and says so, so the model can narrow rather than assume that was all", "cap reached" in out)

reset()
crowd = [{"email": f"p{i}@example.com"} for i in range(30)]
script["get"] = event(attendees=crowd, description="x" * 2000)
out = gcal.gcal_get_event.invoke({"event_id": "evt-1"})
check("a crowded invitation lists twenty and counts the rest", "(+10 more)" in out)
check("...and a pasted agenda is truncated with its length reported", "(+1500 chars)" in out)

# --- one event ----------------------------------------------------------------------------

print("\nfetching one event")
reset()
script["get"] = event(description="Bring the roadmap", htmlLink="https://calendar.google.com/x", organizer={"email": "ada@example.com"})
out = gcal.gcal_get_event.invoke({"event_id": "evt-1", "calendar_id": "team@example.com"})
check("it asks for the event on the calendar it was told", calls[0][1] == {"calendarId": "team@example.com", "eventId": "evt-1"})
check("the description comes back", "Bring the roadmap" in out)
check("...and the organiser", "ada@example.com" in out)
check("an empty id is an answer, not a call", gcal.gcal_get_event.invoke({"event_id": "  "}).startswith("Cannot fetch"))
check("...and it really did not call", len(calls) == 1)

# --- creating -----------------------------------------------------------------------------

print("\ncreating sends exactly the fields it was given")
reset()
script["insert"] = event(id="evt-new", attendees=[{"email": "ada@example.com"}, {"email": "bob@example.com"}])
out = gcal.gcal_create_event.invoke(
    {
        "summary": "Design review",
        "start": "2026-03-04T14:00:00+00:00",
        "end": "2026-03-04T15:00:00+00:00",
        "attendees": "ada@example.com, bob@example.com",
        "location": "Room 4",
    }
)
body = calls[0][1]["body"]
check("the created event's id is reported", "evt-new" in out)
check("the times are wrapped as Google wants them", body["start"] == {"dateTime": "2026-03-04T14:00:00+00:00"})
check("comma-separated attendees become the list Google expects", body["attendees"] == [{"email": "ada@example.com"}, {"email": "bob@example.com"}])
check("a field nobody gave a value to is absent, not empty", "description" not in body)
check("and the answer names who was invited", "bob@example.com" in out)

print("\nand refuses to send something it knows Google will reject")
reset()
check("no summary is an answer, not a call", gcal.gcal_create_event.invoke({"summary": " ", "start": "a", "end": "b"}).startswith("Cannot create"))
check("no end time either", gcal.gcal_create_event.invoke({"summary": "x", "start": "a", "end": " "}).startswith("Cannot create"))
long_description = "x" * (gcal.MAX_DESCRIPTION_CHARS + 1)
check(
    "a description longer than the cap is refused before it is written into somebody's invitation",
    "too long" in gcal.gcal_create_event.invoke({"summary": "x", "start": "a", "end": "b", "description": long_description}),
)
check("none of those reached the network", len(calls) == 0)

# --- updating -----------------------------------------------------------------------------

print("\nupdating merges onto the current event rather than replacing it")
reset()
script["get"] = event(description="Keep me", location="Room 2", attendees=[{"email": "ada@example.com"}])
script["update"] = event(summary="Renamed", description="Keep me", location="Room 2")
out = gcal.gcal_update_event.invoke({"event_id": "evt-1", "summary": "Renamed"})
sent_body = calls[1][1]["body"]
check("it fetches first", calls[0][0] == "get")
check("...then updates", calls[1][0] == "update")
check("the new title is sent", sent_body["summary"] == "Renamed")
check("and the fields nobody mentioned survive", sent_body["description"] == "Keep me" and sent_body["location"] == "Room 2")
check("...including the guest list", sent_body["attendees"] == [{"email": "ada@example.com"}])
check("the answer says which field moved", "summary changed" in out)

print("\nand replacing the guest list says who was on it")
reset()
script["get"] = event(attendees=[{"email": "ada@example.com"}, {"email": "bob@example.com"}])
script["update"] = event(attendees=[{"email": "cleo@example.com"}])
out = gcal.gcal_update_event.invoke({"event_id": "evt-1", "attendees": "cleo@example.com"})
check("the new list is what is sent", calls[1][1]["body"]["attendees"] == [{"email": "cleo@example.com"}])
check("...and the old one is reported, because everybody on it was just uninvited", "bob@example.com" in out)

print("\nan update with nothing in it is not a call")
reset()
out = gcal.gcal_update_event.invoke({"event_id": "evt-1"})
check("it says there is nothing to do", "Nothing to update" in out)
check("...and does nothing", len(calls) == 0)
check("an empty id is refused too", gcal.gcal_update_event.invoke({"event_id": " ", "summary": "x"}).startswith("Cannot update"))

# --- the posture --------------------------------------------------------------------------

print("\nthere is no way to delete an event, and that is the posture rather than an omission")
names = {t.name for t in gcal.TEMPLATE_TOOLS}
check("four tools", names == {"gcal_list_events", "gcal_get_event", "gcal_create_event", "gcal_update_event"}, ", ".join(sorted(names)))
source = (__import__("pathlib").Path(gcal.__file__)).read_text(encoding="utf-8")
check("nothing in the template calls delete()", ".delete(" not in source)
check("...and the scopes stop at calendar.events", all("calendar.events" in s or "calendar.readonly" in s for s in gcal.SCOPES))
check("...which is not the wide `auth/calendar`", "https://www.googleapis.com/auth/calendar" not in gcal.SCOPES)

# --- credentials --------------------------------------------------------------------------

print("\nthe access token is preferred, and the triple is the fallback")
reset()
configure(access_token="ya29.hosted")
script["list"] = {"items": []}
gcal.gcal_list_events.invoke({})
check("google-auth is handed a bearer token", built[-1]["credentials"].kwargs.get("token") == "ya29.hosted")
check("...and no refresh material at all", "refresh_token" not in built[-1]["credentials"].kwargs)

reset()
configure(access_token=None, triple=True)
gcal.gcal_list_events.invoke({})
check("without one, the refresh triple is used", built[-1]["credentials"].kwargs.get("refresh_token") == "1//refresh")
check("...constructed with no access token, so google-auth exchanges it on first use", built[-1]["credentials"].kwargs.get("token") is None)

print("\nthe cached client cannot outlive the credential it was built from")
reset()
configure(access_token="ya29.first")
gcal.gcal_list_events.invoke({})
gcal.gcal_list_events.invoke({})
check("two calls on one credential build one client", len(built) == 1)
configure(access_token="ya29.second")
gcal.gcal_list_events.invoke({})
check("...and a changed credential builds another", len(built) == 2)

configure(access_token=None)
raised = ""
try:
    gcal.gcal_list_events.invoke({})
except Exception as exc:  # noqa: BLE001 — the type is what is under test
    raised = f"{type(exc).__name__}: {exc}"
check("stripping the environment RAISES rather than serving the cache", raised.startswith("RuntimeError"), raised)
check("...and the message names what is missing", "GCAL_ACCESS_TOKEN" in raised and "GCAL_CLIENT_ID" in raised)
check("...and never quotes a value", "ya29" not in raised)

print("\nand an absent SDK is a clean failure rather than an import crash")
reset()
configure(access_token="ya29.token")
remove_sdk()
raised = ""
try:
    gcal.gcal_get_event.invoke({"event_id": "evt-1"})
except Exception as exc:  # noqa: BLE001
    raised = f"{type(exc).__name__}: {exc}"
check("it raises RuntimeError", raised.startswith("RuntimeError"), raised)
check("...naming both packages and the command that installs them", "google-api-python-client" in raised and "uv sync --extra connectors" in raised)
install_sdk()

print("\nALL CORRECT" if failures == 0 else f"\n{failures} FAILURES")
sys.exit(0 if failures == 0 else 1)
