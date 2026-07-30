"""Gmail connector — search mail and draft replies.

Reviewed template. Copied byte-for-byte into generated projects; the builder model is shown
only the signatures and may not rewrite it.

Auth: OAuth2 with a pre-obtained refresh token, supplied via the environment. Jaroku does
not run the interactive consent flow (that arrives later with the secrets manager) — the
user obtains a refresh token once, out of band, and pastes it into runtime/.env.

Scopes requested are the narrowest that support these two tools:
    gmail.readonly   read messages
    gmail.compose    create drafts

Deliberately no send capability. `gmail_create_draft` creates a draft and stops; a human
presses send. An agent that can email the world unattended is a different risk class, and
that decision should be explicit rather than a side effect of picking a connector.

Environment:
    GMAIL_CLIENT_ID
    GMAIL_CLIENT_SECRET
    GMAIL_REFRESH_TOKEN

A tool that could not do its job raises. It does not return the reason as if it were an answer.

That distinction is the whole point of the trace: LangChain records a returned string as a
successful tool call, so a template that caught "not configured" and returned the message produced
a green, successful-looking step whose content happened to be an error — and the model, seeing a
normal tool result, treated the text as data and answered the user from it. The failure was
invisible in exactly the place built to make failures visible.

Raising instead means the callback layer sees on_tool_error (the step goes red) and LangGraph's
ToolNode, configured with handle_tool_errors=True, still hands the message to the model as an
error-flagged ToolMessage. Nothing is hidden from the model and nothing is hidden from the trace.

Returning is still right for "the tool ran and the answer is empty" — no messages matched, zero
rows. That is a result, not a failure.
"""

from __future__ import annotations

import base64
import os
from email.message import EmailMessage

from langchain_core.tools import tool

REQUIRED_ENV = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
]
TOKEN_URI = "https://oauth2.googleapis.com/token"
MAX_BODY_CHARS = 2000

_MISSING_DEPS = (
    "The Gmail connector needs 'google-api-python-client' and 'google-auth'. Install the "
    "connector extras: uv sync --extra connectors"
)


def _service():
    """Build an authorized Gmail client, or raise RuntimeError with an actionable message.

    Credentials are constructed with no access token: google-auth exchanges the refresh
    token on first use and keeps it fresh. Secret values are never logged or returned.
    """
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        raise RuntimeError(
            f"Gmail is not configured: {', '.join(missing)} not set in the environment. "
            "Add them to runtime/.env."
        )

    try:
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
    except ImportError as exc:
        raise RuntimeError(_MISSING_DEPS) from exc

    creds = Credentials(
        token=None,
        refresh_token=os.environ["GMAIL_REFRESH_TOKEN"],
        client_id=os.environ["GMAIL_CLIENT_ID"],
        client_secret=os.environ["GMAIL_CLIENT_SECRET"],
        token_uri=TOKEN_URI,
        scopes=SCOPES,
    )
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def _header(payload: dict, name: str) -> str:
    for h in payload.get("headers", []):
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


@tool
def gmail_search(query: str, max_results: int = 10) -> str:
    """Search the user's Gmail and return matching messages (sender, subject, snippet).

    `query` uses Gmail search syntax, e.g. 'from:acme.com is:unread',
    'subject:invoice newer_than:7d'. Returns at most 25 messages.
    """
    max_results = max(1, min(int(max_results or 10), 25))
    try:
        service = _service()
        listing = (
            service.users().messages()
            .list(userId="me", q=query, maxResults=max_results)
            .execute()
        )
        message_ids = [m["id"] for m in listing.get("messages", [])]
        if not message_ids:
            return f"No messages matched {query!r}."

        lines = []
        for mid in message_ids:
            msg = (
                service.users().messages()
                .get(userId="me", id=mid, format="metadata",
                     metadataHeaders=["From", "Subject", "Date"])
                .execute()
            )
            payload = msg.get("payload", {})
            lines.append(
                f"- id={mid} | from={_header(payload, 'From')} | "
                f"date={_header(payload, 'Date')}\n"
                f"  subject: {_header(payload, 'Subject')}\n"
                f"  snippet: {msg.get('snippet', '')}"
            )
        return f"{len(lines)} message(s) matching {query!r}:\n" + "\n".join(lines)
    except RuntimeError:
        raise  # not configured, or a missing dependency — a failure, not an answer
    except Exception as exc:
        raise RuntimeError(f"Gmail search failed: {type(exc).__name__}: {exc}") from exc


@tool
def gmail_create_draft(to: str, subject: str, body: str, reply_to_message_id: str = "") -> str:
    """Create a Gmail draft reply. Creates a draft only — it does NOT send the email.

    `to` is the recipient address, `body` is plain text. Pass `reply_to_message_id` (an id
    from gmail_search) to thread the draft onto an existing conversation.
    """
    if not to.strip():
        return "Cannot create a draft: `to` is empty."
    if len(body) > MAX_BODY_CHARS:
        return f"Draft body is too long ({len(body)} chars, limit {MAX_BODY_CHARS})."

    try:
        service = _service()

        message = EmailMessage()
        message["To"] = to
        message["Subject"] = subject
        message.set_content(body)

        draft_body: dict = {
            "message": {
                "raw": base64.urlsafe_b64encode(message.as_bytes()).decode()
            }
        }

        if reply_to_message_id:
            # Thread the draft: Gmail needs the threadId, which we read off the original.
            original = (
                service.users().messages()
                .get(userId="me", id=reply_to_message_id, format="metadata")
                .execute()
            )
            draft_body["message"]["threadId"] = original.get("threadId")

        draft = service.users().drafts().create(userId="me", body=draft_body).execute()
        return (
            f"Draft created (id={draft.get('id')}) to {to} with subject {subject!r}. "
            "It has NOT been sent — review and send it from Gmail."
        )
    except RuntimeError:
        raise  # not configured, or a missing dependency — a failure, not an answer
    except Exception as exc:
        raise RuntimeError(f"Creating the draft failed: {type(exc).__name__}: {exc}") from exc


TEMPLATE_TOOLS = [gmail_search, gmail_create_draft]
