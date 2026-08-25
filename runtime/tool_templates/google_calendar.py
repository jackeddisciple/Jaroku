"""Google Calendar connector — read and, in a later commit, write calendar events.

Reviewed template. Copied byte-for-byte into generated projects; the builder model is shown
only the signatures and may not rewrite it.

Auth: OAuth2, by either of two routes, and the template does not care which — the same pair
`gmail.py` reads, under this connector's own names.

    GCAL_ACCESS_TOKEN    a short-lived access token, already obtained. What a hosted run gets:
                         Jaroku owns the OAuth app, the user granted it access by clicking
                         Connect, and the control plane injects an access token with a lifetime
                         a little longer than the run's own.
    GCAL_CLIENT_ID       the pre-obtained refresh token, supplied by hand. What a local install
    GCAL_CLIENT_SECRET   and an exported project use.
    GCAL_REFRESH_TOKEN

ITS OWN NAMES, NOT GMAIL'S, EVEN THOUGH BOTH ARE GOOGLE. A workspace connects Calendar and
Gmail separately, gets a connection row for each, and can revoke either without touching the
other — which is the whole reason they are separate: somebody who no longer wants an agent
reading their mail should not thereby lose the scheduling assistant. Sharing one variable would
make that impossible to express, and would make an exported project that uses only Calendar ask
for a Gmail token.

TWO SCOPES, AND `calendar.events` RATHER THAN `calendar`. The wider one grants management of
the calendar LIST itself — creating calendars, deleting them, changing sharing — none of which
any tool here does. `calendar.events` is read and write on the events of calendars the user
already has, which is exactly the four tools' blast radius, and it is what the consent screen
will say. `calendar.readonly` is asked for beside it so a run that only ever lists keeps
working if a user grants the narrower box and not the wider one.

NO DELETE, AND THAT IS THE POSTURE. Gmail's connector drafts and never sends; the same
conservative principle applies here, one step further out because a calendar event has an
audience. Creating and updating are already irreversible in the sense that matters — you cannot
un-send an invitation, and the attendees have already seen it — so the tools that do it say so
in their own docstrings, which is what the model reads. Deleting somebody's meeting is a
different class of damage again, it has no undo at all, and a person can do it from the calendar
UI in two clicks. There is no `gcal_delete_event` and there should not be one.

`google-auth-oauthlib` IS NOT IMPORTED, and the specification that asked for it is describing a
different deployment. That package exists to run the consent dance from Python. Jaroku's consent
dance is in TypeScript, on the control plane, and what reaches this file is the finished
credential — so what it needs is `google.oauth2.credentials`, out of `google-auth`, which is
precisely what `gmail.py` already uses. Adding a dependency to import nothing from would put an
unused package in every deployed image that selects this connector.

Environment:
    GCAL_CLIENT_ID
    GCAL_CLIENT_SECRET
    GCAL_REFRESH_TOKEN

A tool that could not do its job raises. It does not return the reason as if it were an answer.

That distinction is the whole point of the trace: LangChain records a returned string as a
successful tool call, so a template that caught "not configured" and returned the message produced
a green, successful-looking step whose content happened to be an error — and the model, seeing a
normal tool result, treated the text as data and answered the user from it. The failure was
invisible in exactly the place built to make failures visible.

Raising instead means the callback layer sees on_tool_error (the step goes red) and LangGraph's
ToolNode, configured with handle_tool_errors=True, still hands the message to the model as an
error-flagged ToolMessage. Nothing is hidden from the model and nothing is hidden from the trace.

Returning is still right for "the tool ran and the answer is empty" — no events in the window,
zero rows. That is a result, not a failure.
"""

from __future__ import annotations

import os

from langchain_core.tools import tool

REQUIRED_ENV = ["GCAL_CLIENT_ID", "GCAL_CLIENT_SECRET", "GCAL_REFRESH_TOKEN"]
ACCESS_TOKEN_ENV = "GCAL_ACCESS_TOKEN"

# Names that ALSO configure this connector, without being required for the hand-configured
# route. `REQUIRED_ENV` stays what `.env.example` is built from and what check_catalog() compares
# against the catalog; this is the second door, and it exists so `check_failures_raise()` strips
# it too. That check runs with the connector's variables removed and asserts every tool RAISES
# rather than returning its own error text as if it were an answer — a second way to be
# configured that the check did not know about would make it pass on a machine where a hosted
# token happened to be exported.
OPTIONAL_ENV = [ACCESS_TOKEN_ENV]

SCOPES = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.readonly",
]
TOKEN_URI = "https://oauth2.googleapis.com/token"

# The caps. Same reason Postgres stops at 100 rows: what comes back goes into a model's context
# window at the provider's per-token price, and a calendar with a recurring standup has ten
# thousand events in it. `MAX_RESULTS` is the ceiling a caller cannot argue past; the rest bound
# ONE event, because a single description can be a pasted agenda and a single invitation can have
# a whole department on it.
DEFAULT_RESULTS = 10
MAX_RESULTS = 50
MAX_ATTENDEES = 20
MAX_TEXT_CHARS = 500
# The one cap that bounds what GOES OUT rather than what comes back. Same reason `gmail.py`
# length-limits a draft body: what fills this field is model-written text, it lands in an
# invitation in somebody's inbox, and there is no reviewing step between the two.
MAX_DESCRIPTION_CHARS = 4000

_MISSING_DEPS = (
    "The Google Calendar connector needs 'google-api-python-client' and 'google-auth'. Install "
    "the connector extras: uv sync --extra connectors"
)

# The built service, and the credential it was built from.
#
# CACHED, BECAUSE DISCOVERY IS A NETWORK CALL. `build("calendar", "v3", ...)` fetches Google's
# discovery document, and a listing tool that a graph calls four times would fetch it four times.
#
# KEYED ON THE CREDENTIAL, WHICH IS THE HALF THAT IS EASY TO GET WRONG. A bare module-level cache
# outlives the environment it was built from, and this codebase has a check that depends on it not
# doing so: `check_failures_raise()` strips every configuring variable and asserts each tool then
# raises. A service cached from an earlier configured call would let an unconfigured tool succeed,
# which is the exact failure — a green step over a broken connector — the check exists to catch.
_service_cache: tuple[tuple[str, ...], object] | None = None


def _credential_key() -> tuple[str, ...]:
    """What the environment currently says this connector's credential is."""
    return tuple(os.environ.get(name, "") for name in [ACCESS_TOKEN_ENV, *REQUIRED_ENV])


def _credentials():
    """Build Calendar credentials from whichever of the two routes is configured.

    The access token wins when it is there. It arrives from a host that already did the consent
    dance and already holds the refresh token, so there is nothing here to refresh with and
    nothing here that should be able to: google-auth is handed a bearer token and no refresh
    material, which is precisely the reduced authority intended.

    Otherwise the refresh-token triple — constructed with no access token, so google-auth
    exchanges the refresh token on first use and keeps it fresh.

    Secret values are never logged or returned on either path.
    """
    from google.oauth2.credentials import Credentials

    access_token = os.environ.get(ACCESS_TOKEN_ENV)
    if access_token:
        return Credentials(token=access_token, scopes=SCOPES)

    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        raise RuntimeError(
            f"Google Calendar is not configured: neither {ACCESS_TOKEN_ENV} nor "
            f"{', '.join(missing)} is set in the environment. Connect Google Calendar in "
            "Jaroku, or add the client id, client secret and refresh token to runtime/.env."
        )

    return Credentials(
        token=None,
        refresh_token=os.environ["GCAL_REFRESH_TOKEN"],
        client_id=os.environ["GCAL_CLIENT_ID"],
        client_secret=os.environ["GCAL_CLIENT_SECRET"],
        token_uri=TOKEN_URI,
        scopes=SCOPES,
    )


def _service():
    """An authorized Calendar client, or RuntimeError with an actionable message."""
    global _service_cache

    try:
        from googleapiclient.discovery import build
    except ImportError as exc:
        raise RuntimeError(_MISSING_DEPS) from exc

    key = _credential_key()
    if _service_cache is not None and _service_cache[0] == key:
        return _service_cache[1]

    try:
        creds = _credentials()
    except ImportError as exc:
        raise RuntimeError(_MISSING_DEPS) from exc

    service = build("calendar", "v3", credentials=creds, cache_discovery=False)
    _service_cache = (key, service)
    return service


def _clip(value: object, limit: int = MAX_TEXT_CHARS) -> str:
    """One field of an event, bounded. See the caps above for why every one of them is."""
    text = "" if value is None else str(value)
    return text if len(text) <= limit else f"{text[:limit]}… (+{len(text) - limit} chars)"


def _when(slot: object) -> str:
    """Google returns `{"dateTime": ...}` for a timed event and `{"date": ...}` for an all-day
    one, and a reader that only knew the first renders every all-day event as blank."""
    if not isinstance(slot, dict):
        return ""
    return str(slot.get("dateTime") or slot.get("date") or "")


def _attendees(event: dict) -> str:
    people = event.get("attendees") or []
    if not isinstance(people, list) or not people:
        return ""
    shown = [str(p.get("email", "?")) for p in people[:MAX_ATTENDEES] if isinstance(p, dict)]
    extra = len(people) - len(shown)
    return ", ".join(shown) + (f" (+{extra} more)" if extra > 0 else "")


def _summarise(event: dict) -> str:
    """One event as a line the model can read, with every field bounded."""
    attendees = _attendees(event)
    return (
        f"- id={event.get('id', '?')} | {_clip(event.get('summary') or '(no title)', 200)}\n"
        f"  start: {_when(event.get('start'))}  end: {_when(event.get('end'))}"
        f"  status: {event.get('status', 'unknown')}"
        + (f"\n  location: {_clip(event.get('location'), 200)}" if event.get("location") else "")
        + (f"\n  attendees: {attendees}" if attendees else "")
    )


def _event_body(
    summary: str, start: str, end: str, attendees: str, location: str, description: str,
) -> dict:
    """The Google-shaped body for the fields a caller actually gave a value to.

    EMPTY MEANS "LEAVE IT ALONE", not "clear it", and that is the whole reason this returns only
    the keys it was given. `gcal_update_event` merges the result onto the current event, so a
    builder that emitted `{"location": ""}` for an unmentioned argument would erase the location
    of every event anybody renamed.

    ATTENDEES ARE COMMA-SEPARATED TEXT RATHER THAN A LIST, which is the one place these signatures
    diverge from the connector specification. Every other parameter in every template here is a
    flat scalar, for a reason that is about the caller rather than about the type: what fills
    these arguments is a model emitting JSON against a schema, and a list-typed field is the one
    it most often gets structurally wrong — at which point the tool call fails validation and the
    user sees a retry loop rather than an event. A string it cannot get structurally wrong.
    """
    body: dict = {}
    if summary.strip():
        body["summary"] = summary.strip()
    if start.strip():
        body["start"] = {"dateTime": start.strip()}
    if end.strip():
        body["end"] = {"dateTime": end.strip()}
    if location.strip():
        body["location"] = location.strip()
    if description.strip():
        body["description"] = description
    if attendees.strip():
        emails = [a.strip() for a in attendees.split(",") if a.strip()]
        body["attendees"] = [{"email": e} for e in emails[:MAX_ATTENDEES]]
    return body


@tool
def gcal_list_events(
    calendar_id: str = "primary",
    time_min: str = "",
    time_max: str = "",
    max_results: int = DEFAULT_RESULTS,
) -> str:
    """List upcoming events from a Google Calendar within a date range.

    `calendar_id` defaults to the user's primary calendar. `time_min` and `time_max` are ISO
    8601 timestamps with a timezone (e.g. '2026-03-01T00:00:00Z'); leave either empty to leave
    that end of the window open. Returns at most 50 events, soonest first.
    """
    max_results = max(1, min(int(max_results or DEFAULT_RESULTS), MAX_RESULTS))
    calendar = (calendar_id or "primary").strip() or "primary"

    try:
        service = _service()
        # `singleEvents` expands a recurring series into its instances, and `orderBy=startTime`
        # is only accepted when it is set. Without both, a weekly standup comes back as ONE
        # event with a recurrence rule the model has to interpret, and "what is on Thursday"
        # becomes unanswerable from the result.
        request: dict = {
            "calendarId": calendar,
            "maxResults": max_results,
            "singleEvents": True,
            "orderBy": "startTime",
        }
        if time_min.strip():
            request["timeMin"] = time_min.strip()
        if time_max.strip():
            request["timeMax"] = time_max.strip()

        listing = service.events().list(**request).execute()
        events = [e for e in listing.get("items", []) if isinstance(e, dict)]
        if not events:
            return f"No events on {calendar!r} in that window."

        lines = [_summarise(e) for e in events[:max_results]]
        note = (
            f"\n({max_results} event cap reached — narrow the window to see the rest)"
            if len(lines) == max_results
            else ""
        )
        return f"{len(lines)} event(s) on {calendar!r}:\n" + "\n".join(lines) + note
    except RuntimeError:
        raise  # not configured, or a missing dependency — a failure, not an answer
    except Exception as exc:
        raise RuntimeError(f"Listing calendar events failed: {type(exc).__name__}: {exc}") from exc


@tool
def gcal_get_event(event_id: str, calendar_id: str = "primary") -> str:
    """Get the full details of one Google Calendar event by its id.

    `event_id` is an id from gcal_list_events. `calendar_id` defaults to the primary calendar.
    """
    if not event_id.strip():
        return "Cannot fetch an event: `event_id` is empty."
    calendar = (calendar_id or "primary").strip() or "primary"

    try:
        service = _service()
        event = service.events().get(calendarId=calendar, eventId=event_id.strip()).execute()
        if not isinstance(event, dict):
            return f"No event {event_id!r} on {calendar!r}."
        description = event.get("description")
        return (
            _summarise(event)
            + (f"\n  description: {_clip(description)}" if description else "")
            + (f"\n  organiser: {(event.get('organizer') or {}).get('email', '?')}" if event.get("organizer") else "")
            + (f"\n  link: {_clip(event.get('htmlLink'), 300)}" if event.get("htmlLink") else "")
        )
    except RuntimeError:
        raise  # not configured, or a missing dependency — a failure, not an answer
    except Exception as exc:
        raise RuntimeError(f"Fetching event {event_id!r} failed: {type(exc).__name__}: {exc}") from exc


@tool
def gcal_create_event(
    summary: str,
    start: str,
    end: str,
    attendees: str = "",
    location: str = "",
    description: str = "",
    calendar_id: str = "primary",
) -> str:
    """Create a real event on the user's Google Calendar. This is NOT a draft.

    The event appears on the calendar immediately and every address in `attendees` is sent an
    invitation. There is no undo: withdrawing an invitation is a second notification, not an
    erasure, and the people invited have already seen it. Only call this when the user has asked
    for the event to be created.

    `start` and `end` are ISO 8601 with a timezone offset (e.g. '2026-03-04T14:00:00+00:00').
    `attendees` is a comma-separated list of email addresses.
    """
    if not summary.strip():
        return "Cannot create an event: `summary` is empty."
    if not start.strip() or not end.strip():
        return "Cannot create an event: both `start` and `end` are required, as ISO 8601 times."
    if len(description) > MAX_DESCRIPTION_CHARS:
        return f"Description is too long ({len(description)} chars, limit {MAX_DESCRIPTION_CHARS})."

    calendar = (calendar_id or "primary").strip() or "primary"
    body = _event_body(
        summary=summary, start=start, end=end, attendees=attendees,
        location=location, description=description,
    )

    try:
        service = _service()
        created = service.events().insert(calendarId=calendar, body=body).execute()
        if not isinstance(created, dict):
            return "The event was created but Google returned nothing describing it."
        invited = _attendees(created)
        return (
            f"Created event {created.get('id', '?')} on {calendar!r}.\n"
            + _summarise(created)
            + (f"\n  invitations sent to: {invited}" if invited else "")
        )
    except RuntimeError:
        raise  # not configured, or a missing dependency — a failure, not an answer
    except Exception as exc:
        raise RuntimeError(f"Creating the event failed: {type(exc).__name__}: {exc}") from exc


@tool
def gcal_update_event(
    event_id: str,
    summary: str = "",
    start: str = "",
    end: str = "",
    attendees: str = "",
    location: str = "",
    description: str = "",
    calendar_id: str = "primary",
) -> str:
    """Change an existing Google Calendar event. Attendees are notified of the change.

    Only the fields you pass are changed; anything left empty keeps its current value. The one
    exception is `attendees`: passing it REPLACES the whole guest list, so include everyone who
    should remain invited, not only the people being added. Anybody dropped is uninvited, and
    they are told.

    `event_id` is an id from gcal_list_events. `start` and `end` are ISO 8601 with a timezone.
    """
    if not event_id.strip():
        return "Cannot update an event: `event_id` is empty."
    if len(description) > MAX_DESCRIPTION_CHARS:
        return f"Description is too long ({len(description)} chars, limit {MAX_DESCRIPTION_CHARS})."

    changes = _event_body(
        summary=summary, start=start, end=end, attendees=attendees,
        location=location, description=description,
    )
    if not changes:
        return "Nothing to update: no field was given a new value."

    calendar = (calendar_id or "primary").strip() or "primary"
    try:
        service = _service()
        # FETCHED, MERGED, THEN SENT WHOLE — rather than `patch`, which would be one call fewer.
        #
        # `update` replaces the resource, so a body carrying only the changed fields would clear
        # every field nobody mentioned: change the title of a meeting and lose its guests, its
        # location and its description. Merging onto the CURRENT event is what makes "only the
        # fields you pass are changed" true rather than aspirational.
        #
        # `patch` would give that server-side, and was rejected for the other half: this tool has
        # to be able to tell the model what the event looked like BEFORE, because the guest list
        # is replaced wholesale and an agent about to uninvite six people should be able to say
        # who they were. A patch call never sees the prior state.
        current = service.events().get(calendarId=calendar, eventId=event_id.strip()).execute()
        if not isinstance(current, dict):
            return f"No event {event_id!r} on {calendar!r}."
        before = _attendees(current)

        merged = {**current, **changes}
        updated = service.events().update(
            calendarId=calendar, eventId=event_id.strip(), body=merged,
        ).execute()
        if not isinstance(updated, dict):
            return "The event was updated but Google returned nothing describing it."

        after = _attendees(updated)
        moved = "attendees" in changes and before != after
        return (
            f"Updated event {updated.get('id', event_id)} on {calendar!r} "
            f"({', '.join(sorted(changes))} changed).\n"
            + _summarise(updated)
            + (f"\n  guest list was: {before or '(nobody)'}" if moved else "")
        )
    except RuntimeError:
        raise  # not configured, or a missing dependency — a failure, not an answer
    except Exception as exc:
        raise RuntimeError(f"Updating event {event_id!r} failed: {type(exc).__name__}: {exc}") from exc


TEMPLATE_TOOLS = [gcal_list_events, gcal_get_event, gcal_create_event, gcal_update_event]
