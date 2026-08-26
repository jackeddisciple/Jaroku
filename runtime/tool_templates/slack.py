"""Slack connector — read channels and post messages.

Reviewed template. Copied byte-for-byte into generated projects; the builder model is shown
only the signatures and may not rewrite it.

Auth: a bot token (`xoxb-...`) from a Slack app installed to the workspace. Bot tokens are
scoped per-app, so grant only what the agent needs:
    channels:read     slack_list_channels
    chat:write        slack_post_message
    channels:history  slack_read_channel

Posting is a real, irreversible, externally-visible side effect — unlike the Gmail
connector, which stops at a draft. There is no undo, so the message is length-capped and
the tool reports exactly where it landed. Point the agent at a test channel first.

Environment:
    SLACK_BOT_TOKEN    xoxb-...

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

import os

from langchain_core.tools import tool

from . import require_enabled

REQUIRED_ENV = ["SLACK_BOT_TOKEN"]

MAX_MESSAGE_CHARS = 4000
MAX_HISTORY = 50

_MISSING_DEPS = (
    "The Slack connector needs the 'slack_sdk' package. Install the connector extras: "
    "uv sync --extra connectors"
)


def _client():
    """Build an authorized Slack client, or raise RuntimeError with an actionable message."""
    # BEFORE THE CREDENTIAL CHECK, because the two are different problems with different fixes.
    # The host already declines to inject a disabled connector's token, so without this the
    # failure would read "SLACK_BOT_TOKEN is not set" and send somebody to the Connections panel
    # to repair a credential that is perfectly fine. See `require_enabled`.
    require_enabled("slack", "Slack")
    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        raise RuntimeError(
            "Slack is not configured: SLACK_BOT_TOKEN is not set in the environment. "
            "Add it to runtime/.env."
        )
    try:
        from slack_sdk import WebClient
    except ImportError as exc:
        raise RuntimeError(_MISSING_DEPS) from exc
    return WebClient(token=token, timeout=15)


def _normalize_channel(channel: str) -> str:
    """Accept '#general', 'general' or a channel id — Slack wants the bare name or id."""
    return channel.strip().lstrip("#")


@tool
def slack_list_channels(limit: int = 50) -> str:
    """List the public Slack channels the bot can see, with their ids and member counts."""
    limit = max(1, min(int(limit or 50), 200))
    try:
        client = _client()
        response = client.conversations_list(
            types="public_channel", limit=limit, exclude_archived=True
        )
        channels = response.get("channels", [])
        if not channels:
            return "No channels visible to this bot. Has it been invited to any?"
        lines = [
            f"- #{c['name']} (id={c['id']}, {c.get('num_members', 0)} members)"
            for c in channels
        ]
        return f"{len(lines)} channel(s):\n" + "\n".join(lines)
    except RuntimeError:
        raise  # not configured, or a missing dependency — a failure, not an answer
    except Exception as exc:
        raise RuntimeError(f"Listing channels failed: {type(exc).__name__}: {exc}") from exc


@tool
def slack_read_channel(channel: str, limit: int = 20) -> str:
    """Read the most recent messages from a Slack channel. `channel` is a name or id."""
    limit = max(1, min(int(limit or 20), MAX_HISTORY))
    name = _normalize_channel(channel)
    if not name:
        return "Cannot read: `channel` is empty."
    try:
        client = _client()
        history = client.conversations_history(channel=name, limit=limit)
        messages = history.get("messages", [])
        if not messages:
            return f"No messages in {channel!r}."
        lines = [
            f"- [{m.get('ts', '?')}] {m.get('user') or m.get('bot_id') or 'unknown'}: "
            f"{(m.get('text') or '').strip()}"
            for m in messages
        ]
        return f"{len(lines)} message(s) from {channel!r}:\n" + "\n".join(lines)
    except RuntimeError:
        raise  # not configured, or a missing dependency — a failure, not an answer
    except Exception as exc:
        # channel_not_found usually means the bot was never invited to the channel.
        raise RuntimeError(f"Reading {channel!r} failed: {type(exc).__name__}: {exc}") from exc


@tool
def slack_post_message(channel: str, text: str) -> str:
    """Post a message to a Slack channel. This is immediate and cannot be undone.

    `channel` is a channel name ('#general' or 'general') or id. The bot must be a member.
    """
    name = _normalize_channel(channel)
    if not name:
        return "Cannot post: `channel` is empty."
    if not text.strip():
        return "Cannot post: `text` is empty."
    if len(text) > MAX_MESSAGE_CHARS:
        return f"Message is too long ({len(text)} chars, limit {MAX_MESSAGE_CHARS})."

    try:
        client = _client()
        response = client.chat_postMessage(channel=name, text=text)
        return (
            f"Posted to #{name} (ts={response.get('ts')}). "
            f"{len(text)} characters delivered."
        )
    except RuntimeError:
        raise  # not configured, or a missing dependency — a failure, not an answer
    except Exception as exc:
        raise RuntimeError(f"Posting to {channel!r} failed: {type(exc).__name__}: {exc}") from exc


TEMPLATE_TOOLS = [slack_list_channels, slack_read_channel, slack_post_message]
