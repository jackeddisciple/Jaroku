"""Postgres connector — read-only SQL access.

Reviewed template. Copied byte-for-byte into generated projects; the builder model is shown
only the signatures and may not rewrite it.

Security posture — an LLM writes the SQL, so "read-only" is enforced twice, independently:

  1. Statement inspection (`assert_read_only`): comments stripped, a single statement only,
     must start with SELECT/WITH, and no data-modifying or DDL keyword anywhere in the text.
     The keyword scan matters because Postgres allows data-modifying CTEs — a query like
     `WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x` starts with WITH and is not a
     read.
  2. A read-only transaction (`conn.read_only = True`). Postgres itself rejects any write,
     so a parser bug is contained rather than exploited.

Layer 2 is the real guarantee; layer 1 exists to fail fast with a message the agent can act
on. Grant the connection's role SELECT-only privileges for a third layer.

Environment:
    DATABASE_URL   postgresql://user:pass@host:5432/dbname

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
import re

from langchain_core.tools import tool

from . import require_enabled

REQUIRED_ENV = ["DATABASE_URL"]

MAX_ROWS = 100
STATEMENT_TIMEOUT_MS = 10_000

# Whole-word match, anywhere in the statement — catches data-modifying CTEs.
_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|merge|"
    r"call|do|vacuum|reindex|refresh|listen|notify|prepare|execute|set|reset)\b",
    re.IGNORECASE,
)
_LINE_COMMENT = re.compile(r"--[^\n]*")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)


class UnsafeQuery(ValueError):
    """The statement is not a single, read-only query."""


def _strip_comments(sql: str) -> str:
    """Remove comments so they cannot hide a keyword from the scan."""
    return _BLOCK_COMMENT.sub(" ", _LINE_COMMENT.sub(" ", sql))


def assert_read_only(sql: str) -> str:
    """Raise UnsafeQuery unless `sql` is one read-only statement. Returns the cleaned SQL."""
    cleaned = _strip_comments(sql).strip().rstrip(";").strip()
    if not cleaned:
        raise UnsafeQuery("empty query")
    if ";" in cleaned:
        raise UnsafeQuery("multiple statements are not allowed; send one SELECT at a time")

    first = cleaned.split(None, 1)[0].lower()
    if first not in ("select", "with"):
        raise UnsafeQuery(f"only SELECT queries are allowed (got {first.upper()!r})")

    found = _FORBIDDEN.search(cleaned)
    if found:
        raise UnsafeQuery(
            f"{found.group(0).upper()!r} is not allowed — this tool is read-only"
        )
    return cleaned


@tool
def pg_query(sql: str) -> str:
    """Run a read-only SQL SELECT against the Postgres database and return the rows.

    Only a single SELECT (or WITH ... SELECT) statement is permitted; writes and DDL are
    rejected. Results are capped at 100 rows, so add LIMIT/WHERE to narrow large tables.
    """
    # BEFORE THE CREDENTIAL CHECK — see `require_enabled`. "Postgres is not configured" would send
    # somebody to fix a DATABASE_URL that is perfectly fine.
    require_enabled("postgres", "Postgres")
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("Postgres is not configured: DATABASE_URL is not set in the environment.")

    try:
        cleaned = assert_read_only(sql)
    except UnsafeQuery as exc:
        # The guard doing its job is still a call that produced no rows, and a blocked write is
        # the single most worth-seeing event in a trace. It goes red.
        raise RuntimeError(f"Query rejected: {exc}") from exc

    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            "The Postgres connector needs the 'psycopg' package. Install the connector "
            "extras: uv sync --extra connectors"
        ) from exc

    try:
        with psycopg.connect(url, connect_timeout=10) as conn:
            # Defense in depth: the server refuses writes regardless of the parser above.
            conn.read_only = True
            with conn.cursor() as cur:
                cur.execute(f"SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}")
                cur.execute(cleaned)
                if cur.description is None:
                    return "Query ran but returned no result set."
                columns = [d[0] for d in cur.description]
                rows = cur.fetchmany(MAX_ROWS)
    except Exception as exc:
        # Connection refused, bad SQL, timeout, permission denied — all actionable, all failures.
        raise RuntimeError(f"Query failed: {type(exc).__name__}: {exc}") from exc

    if not rows:
        return "Query returned 0 rows."

    header = " | ".join(columns)
    body = "\n".join(" | ".join("" if v is None else str(v) for v in row) for row in rows)
    note = f"\n({MAX_ROWS} row cap reached — add a LIMIT or narrow the WHERE clause)" if len(rows) == MAX_ROWS else ""
    return f"{header}\n{'-' * len(header)}\n{body}\n\n{len(rows)} row(s).{note}"


TEMPLATE_TOOLS = [pg_query]
