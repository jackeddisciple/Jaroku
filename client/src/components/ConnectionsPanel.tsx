// What this workspace has authorised Jaroku to reach on somebody's behalf.
//
// The organising rule is the one the MCP panel has, pointed at a different risk. There, the thing
// a user must not forget is that the code is unreviewed. Here it is that THE GRANT IS AGAINST A
// REAL ACCOUNT: connecting Gmail points every agent in this workspace at one person's mailbox,
// and the person clicking the button is the person whose mailbox it will be. So the consent lines
// are rendered BEFORE the button rather than after it, in sentences rather than as scope strings,
// and the account a connection points at is on the row rather than in a tooltip.
//
// SCOPE STRINGS ARE SHOWN TOO, AND SECOND. "https://www.googleapis.com/auth/gmail.compose" tells
// nobody anything about whether an agent can email their customers, which is why the sentences
// come first — but it is also the only exact statement of what was granted, and an interface that
// only paraphrased would be one you cannot audit. Both, in that order.
//
// AND WHAT IS GRANTED IS NOT WHAT WAS ASKED FOR. A provider may hand back less: Google's consent
// screen lets somebody tick one box and not the other. The row renders `scopes` from the server,
// which is the granted set, so a partial consent reads as partial rather than as success.
//
// There is no optimistic state here beyond "a flow is starting". Every mutation goes over the
// connections channel and comes back as a full snapshot, exactly as the MCP and provider panels
// do — and a connection's status is a fact about a token this browser has never seen, so a
// component asserting one would be a component making it up.

import { useEffect, useState } from "react";
import {
  CONNECTION_STATUS_LABEL,
  useConnectionStore,
} from "../store/connectionStore.ts";
import { sendConnectConnector, sendDisconnectConnector, sendListConnections } from "../lib/socket.ts";
import { createSecret, revealSecret } from "../lib/secrets.ts";
import { ICON, TEXT } from "../lib/tokens.ts";
import { EmptyState } from "./EmptyState.tsx";
import { iconBtn, outlineBtn, quietBtn } from "./buttons.ts";
import { StatusDot } from "./StatusBadge.tsx";
import {
  AlertTriangleIcon, CheckIcon, LockIcon, PlugIcon, RefreshIcon, ShieldCheckIcon, XIcon,
} from "./panelIcons.tsx";
import { UnpluggedIcon } from "./inboxIcons.tsx";
import type { ConnectionField as ConnectionFieldView, ConnectionView } from "../types.ts";

/** What each status means, in the words somebody would use to decide what to do next. */
const STATUS_COPY: Record<string, { state: "ok" | "error" | "pending" | "neutral"; icon: typeof CheckIcon }> = {
  active: { state: "ok", icon: CheckIcon },
  reauth_required: { state: "pending", icon: AlertTriangleIcon },
  revoked: { state: "neutral", icon: XIcon },
  disconnected: { state: "neutral", icon: PlugIcon },
};

// --- the connectors nobody can connect FOR you --------------------------------
//
// Postgres has no consent screen, and neither do Stripe or HTTP: the value IS the credential, so
// there is nothing to redirect to and nobody to ask on the user's behalf. They were therefore
// absent from the one screen named for connections, and somebody looking for "is Stripe set up in
// this workspace" was sent to the Secrets tab to type a variable name from memory. The row is the
// same row; what differs is that it ends in fields instead of a button.
//
// THE VALUE DOES NOT GO OVER THE SOCKET. Everything else on this panel rides the connections
// channel, and this deliberately does not: `POST /v1/secrets` is behind the elevation gate, a
// WebSocket frame cannot carry an elevation header, and a credential command on a socket is a
// credential command nothing can gate. So the field posts over HTTPS to the route the Secrets tab
// already uses, and the snapshot that comes back afterwards is what updates the row.
//
// AND THE NON-SECRET ONE CAN BE READ BACK. `HTTP_ALLOWED_DOMAINS` is a policy, not a credential —
// masking it would make the field somebody most needs to re-read the one they cannot, and an
// allowlist retyped from memory is how a domain silently drops off it. It is fetched through the
// same elevation-gated reveal route the Secrets tab uses, on demand, and held in local state for
// as long as the field is on screen.

function ConnectorField({ field, onDone }: { field: ConnectionFieldView; onDone: () => void }) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Validated on blur as well as on save, which §7.3 asks for and which is worth the duplication:
  // a person pasting a list of six domains should learn that one of them has a scheme on it while
  // the cursor is still in the box, not after a round trip. The SERVER still decides — this is the
  // shape check, and it deliberately does not try to reproduce the private-range refusal, which
  // needs DNS and is the server's alone.
  const shapeProblem = (raw: string): string | null => {
    if (field.name !== "HTTP_ALLOWED_DOMAINS") return null;
    const bad = raw
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean)
      .filter((d) => /[*/:@\s]/.test(d) || !d.includes(".") || d.startsWith(".") || d.includes(".."));
    if (bad.length === 0) return null;
    return `not a hostname: ${bad.slice(0, 3).join(", ")} — bare hostnames only, no scheme, path, port or wildcard`;
  };

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const local = shapeProblem(trimmed);
    if (local) {
      setProblem(local);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await createSecret({ name: field.name, value: trimmed, kind: "custom" });
      setValue("");
      setEditing(false);
      onDone();
    } catch (err) {
      // The server's sentence, which is written in this codebase and safe to render — the same
      // rule the panel's own error strip follows. It is the one that knows a domain resolves into
      // a private range, and the one that refuses a full-access Stripe key.
      setProblem(err instanceof Error ? err.message : "that value could not be stored");
    } finally {
      setBusy(false);
    }
  };

  const show = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setValue(await revealSecret(field.name));
      setEditing(true);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "that value could not be read");
    } finally {
      setBusy(false);
    }
  };

  const settled = field.configured && !editing;

  return (
    <div className="mt-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] text-ink">{field.label}</span>
        <span className="font-mono text-[10px]" style={{ color: TEXT.muted }}>
          {field.name}
        </span>
        {!field.required ? (
          <span className="text-[10px] text-faint">optional</span>
        ) : null}
      </div>

      {settled ? (
        <div className="mt-1 flex items-center gap-1.5">
          <span className="flex items-center gap-1.5 text-[11px]" style={{ color: TEXT.muted }}>
            <StatusDot state="ok" icon={CheckIcon} size={ICON.badge} />
            {field.maskedHint ?? "set"}
          </span>
          {/* A non-secret field can be read back and edited; a credential can only be replaced.
              Rotating a credential from here writes a new value over the old one, which is what
              the Secrets tab's own Rotate does and is the only safe verb for a value nothing can
              show you. */}
          <button className={quietBtn} disabled={busy} onClick={field.secret ? () => setEditing(true) : show}>
            {field.secret ? "Replace" : busy ? "Reading…" : "Edit"}
          </button>
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-1.5">
          <input
            className="min-w-0 flex-1 rounded-control bg-panel px-2.5 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-faint focus:shadow-focusring"
            type={field.secret ? "password" : "text"}
            value={value}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            placeholder={field.name}
            onChange={(e) => {
              setValue(e.target.value);
              if (problem) setProblem(null);
            }}
            onBlur={() => setProblem(shapeProblem(value.trim()))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") {
                setValue("");
                setEditing(false);
                setProblem(null);
              }
            }}
          />
          <button className={outlineBtn} disabled={busy || !value.trim()} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      )}

      {problem ? (
        <p className="mt-1 text-[11px] text-err">{problem}</p>
      ) : (
        <p className="mt-1 text-[11px]" style={{ color: TEXT.muted }}>
          {field.hint}
        </p>
      )}
    </div>
  );
}

// --- one connector -----------------------------------------------------------

function ConnectionRow({ connection }: { connection: ConnectionView }) {
  const connecting = useConnectionStore((s) => s.connecting[connection.connectorId] === true);
  const status = STATUS_COPY[connection.status] ?? STATUS_COPY["disconnected"]!;
  const connected = connection.status === "active";
  const needsReconnect = connection.status === "reauth_required";

  return (
    <div className="rounded-control px-2 py-2 transition-colors hover:bg-active/30">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0" style={{ color: TEXT.muted }}>
          <PlugIcon size={ICON.sm} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12px] text-ink">{connection.label}</span>
            {/* A DOT AND A WORD, NOT A CAPS PILL. `not connected` rendered as an outlined
                uppercase badge beside the service's name — caps, plus an outline, plus the card's
                own border, which made the ABSENCE of a connection the loudest element on it. A
                binary state is a coloured dot and a lowercase label; that is what a dot is for. */}
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <StatusDot state={status.state} icon={status.icon} size={ICON.badge} />
              <span className="text-[10px] text-faint">
                {CONNECTION_STATUS_LABEL[connection.status] ?? connection.status}
              </span>
            </span>
            {/* WHOSE ACCOUNT. Not a tooltip: a workspace with two Google accounts connected at
                different times has no other way to tell which mailbox its agents are reading,
                and "disconnect the wrong one" is a coin flip without this. */}
            {connection.account ? (
              <span className="font-mono text-[11px]" style={{ color: TEXT.muted }}>
                {connection.account}
              </span>
            ) : null}
          </div>

          {/* THE BANNER THAT MATTERS. A revoked grant is a decision somebody made; this is the
              one state where agents are quietly failing and only a person can fix it. */}
          {needsReconnect ? (
            <p className="mt-1 text-[12px] text-ink">
              Agents using {connection.label} will fail until this is reconnected.
              {connection.lastError ? (
                <span className="block font-mono text-[11px] mt-0.5" style={{ color: TEXT.muted }}>
                  {connection.lastError}
                </span>
              ) : null}
            </p>
          ) : null}

          {/* WHAT CONNECTING MEANS, BEFORE THE BUTTON — as ONE muted line rather than four
              bulleted ones. Two connectors used to fill the entire panel: a bordered card each,
              with a caps status pill and four lines of prose describing what each can and cannot
              do. The prose is still here and still shown while it is a decision rather than after
              it has been made; it is a sentence instead of a list, and the full text is on hover
              when it runs past the row. */}
          {!connected ? (
            <p
              className="mt-1 flex items-start gap-1.5 text-[11px]"
              style={{ color: TEXT.muted }}
              title={connection.consent.join(" · ")}
            >
              <span className="mt-0.5 shrink-0">
                <ShieldCheckIcon size={ICON.xs} />
              </span>
              <span className="min-w-0">{connection.consent.join(" · ")}</span>
            </p>
          ) : null}

          {/* AND THE EXACT LIST, SECOND. What was GRANTED, which may be less than was asked for. */}
          {connected && connection.scopes.length ? (
            <p className="mt-1 font-mono text-[11px] break-all" style={{ color: TEXT.muted }}>
              {connection.scopes.join("  ")}
            </p>
          ) : null}

          {/* THE FIELDS, for a connector nobody can connect on your behalf. Under the consent
              line and above the buttons, in the same place the OAuth rows put their scope list:
              this is the "what am I agreeing to, and what does it need" part of the row, and a
              person reading down it should meet the same things in the same order whichever kind
              of connector they are looking at. */}
          {connection.auth === "user_secret"
            ? connection.fields.map((field) => (
                <ConnectorField
                  key={field.name}
                  field={field}
                  // The snapshot is what updates the row — nothing here patches a field in from
                  // what it just posted, for the same reason nothing on this panel invents a
                  // status: what is stored is a fact about the vault, and a component asserting
                  // one would be a component making it up.
                  onDone={() => sendListConnections()}
                />
              ))
            : null}

          {/* An unconfigured deployment is not an error state — see ConnectionView.available. It
              says which two variables somebody has to set rather than hiding the connector, which
              would read as a missing feature. */}
          {!connection.available ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-[12px]" style={{ color: TEXT.muted }}>
              <span className="mt-0.5 shrink-0">
                <LockIcon size={ICON.xs} />
              </span>
              <span>
                This deployment has no {connection.provider} OAuth app configured, so there is
                nothing to connect to yet.
              </span>
            </p>
          ) : null}
        </div>
      </div>

      {/* NO BUTTONS ON A `user_secret` ROW, and their absence is the honest shape rather than a
          gap. Connect would have nowhere to send anybody; Disconnect would mean "delete this
          value", which is the Secrets tab's Revoke and carries its own confirmation because the
          credential may be referenced by a running agent. Emptying the field is the verb here,
          and it is where the value is. */}
      <div className={`flex items-center gap-1.5 ${connection.auth === "user_secret" ? "hidden" : ""}`}>
        {connected ? (
          <>
            <button
              className={quietBtn}
              onClick={() => sendConnectConnector(connection.connectorId, "/")}
              disabled={connecting || !connection.available}
              title="Run the consent flow again — to change the account, or to grant a scope that was withheld."
            >
              <span className="inline-flex items-center gap-1.5">
                <RefreshIcon size={ICON.xs} />
                Reconnect
              </span>
            </button>
            {/* An unplug glyph, which already exists in `inboxIcons.tsx`. The sentence stays as
                the tooltip: it is a real consequence and it is too long to be a label. */}
            <button
              className={iconBtn}
              onClick={() => sendDisconnectConnector(connection.connectorId)}
              title="Disconnect — hand the grant back and forget the credentials. Agents using it will report it at their next tool call."
              aria-label={`Disconnect ${connection.label}`}
            >
              <UnpluggedIcon size={ICON.sm} />
            </button>
          </>
        ) : (
          /* OUTLINE, NOT THE FILL. There is one of these per connector, so a filled weight here
             is two or three ink-white buttons stacked down one panel — and the rule is one filled
             action per view. Connecting is a real action; it is not the screen's only one. */
          <button
            className={outlineBtn}
            onClick={() => {
              useConnectionStore.getState().startConnecting(connection.connectorId);
              sendConnectConnector(connection.connectorId, "/");
            }}
            disabled={connecting || !connection.available}
          >
            {connecting ? "Opening…" : needsReconnect ? "Reconnect" : `Connect ${connection.label}`}
          </button>
        )}
      </div>
    </div>
  );
}

// --- the panel ---------------------------------------------------------------

export function ConnectionsPanel() {
  const connections = useConnectionStore((s) => s.connections);
  const loaded = useConnectionStore((s) => s.loaded);
  const error = useConnectionStore((s) => s.error);
  const notice = useConnectionStore((s) => s.notice);

  // Asked for when the panel opens and never on a timer. A connection changes when somebody
  // clicks a button or a provider revokes a grant, and neither is worth a poll per second per
  // open tab — the same reasoning the usage panel's snapshot follows.
  useEffect(() => {
    sendListConnections();
  }, []);

  // What the callback left on the URL, read once and then removed. A query parameter that
  // survived a reload would re-announce a connection every time somebody refreshed the page.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const failed = params.get("connect_failed");
    if (!connected && !failed) return;
    const store = useConnectionStore.getState();
    if (connected) {
      store.setNotice(
        params.get("partial")
          ? `${connected} is connected, but some access was not granted — reconnect to grant the rest.`
          : `${connected} is connected.`,
      );
      // The list on screen predates the flow that just finished, so ask for it again rather than
      // patching a row in from a query string the server did not write.
      sendListConnections();
    } else if (failed) {
      store.setError(
        // Our words, keyed by the KIND the callback put on the URL — never a message from the
        // URL itself, which is a string chosen by whoever sent the request that produced it.
        (
          {
            denied: "that authorisation was declined, so nothing was connected",
            reauth_required: "the provider says that authorisation is no longer valid — try again",
            transient: "the provider did not answer — try again in a moment",
            config: "this deployment's OAuth app is not set up for that connector yet",
          } as Record<string, string>
        )[failed] ?? "that authorisation did not complete",
      );
    }
    const url = new URL(window.location.href);
    for (const key of ["connected", "connect_failed", "partial"]) url.searchParams.delete(key);
    window.history.replaceState({}, "", url.toString());
  }, []);

  return (
    <div className="space-y-3">
      {error ? (
        /* ONE DISMISSAL TREATMENT. These were the word `Dismiss`, twice, while `GitHubPanel`'s
            notice strip — the same idea, one panel over — closes with an XIcon. Two vocabularies
            for "close this transient message" is one of them being wrong. */
        <div className="flex items-start gap-2 rounded-control border border-line px-3 py-2 text-[12px] text-ink">
          <span className="min-w-0 flex-1">{error}</span>
          <button
            className={`${iconBtn} shrink-0`}
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => useConnectionStore.getState().setError(null)}
          >
            <XIcon size={ICON.xs} />
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="flex items-start gap-2 rounded-control border border-line px-3 py-2 text-[12px]" style={{ color: TEXT.muted }}>
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            className={`${iconBtn} shrink-0`}
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => useConnectionStore.getState().setNotice(null)}
          >
            <XIcon size={ICON.xs} />
          </button>
        </div>
      ) : null}

      {/* `loaded` rather than `connections.length`, deliberately. Before the first snapshot
          lands, "nothing is connected" and "we have not been told yet" look identical, and
          rendering the first would flash an empty state at somebody who has connected both. */}
      {!loaded ? null : connections.length === 0 ? (
        <EmptyState
          title="No connectors to connect"
          hint="This deployment offers no OAuth connectors."
          icon={PlugIcon}
          size="inline"
        />
      ) : (
        <div className="space-y-2">
          {connections.map((c) => (
            <ConnectionRow key={c.connectorId} connection={c} />
          ))}
        </div>
      )}
    </div>
  );
}
