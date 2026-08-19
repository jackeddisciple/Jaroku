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

import { useEffect } from "react";
import {
  CONNECTION_STATUS_LABEL,
  useConnectionStore,
} from "../store/connectionStore.ts";
import { sendConnectConnector, sendDisconnectConnector, sendListConnections } from "../lib/socket.ts";
import { ICON, TEXT } from "../lib/tokens.ts";
import { EmptyState } from "./EmptyState.tsx";
import { iconBtn, primaryBtn, quietBtn } from "./buttons.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import {
  AlertTriangleIcon, CheckIcon, LockIcon, PlugIcon, RefreshIcon, ShieldCheckIcon, XIcon,
} from "./panelIcons.tsx";
import { UnpluggedIcon } from "./inboxIcons.tsx";
import type { ConnectionView } from "../types.ts";

/** What each status means, in the words somebody would use to decide what to do next. */
const STATUS_COPY: Record<string, { state: "ok" | "error" | "pending" | "neutral"; icon: typeof CheckIcon }> = {
  active: { state: "ok", icon: CheckIcon },
  reauth_required: { state: "pending", icon: AlertTriangleIcon },
  revoked: { state: "neutral", icon: XIcon },
  disconnected: { state: "neutral", icon: PlugIcon },
};

// --- one connector -----------------------------------------------------------

function ConnectionRow({ connection }: { connection: ConnectionView }) {
  const connecting = useConnectionStore((s) => s.connecting[connection.connectorId] === true);
  const status = STATUS_COPY[connection.status] ?? STATUS_COPY["disconnected"]!;
  const connected = connection.status === "active";
  const needsReconnect = connection.status === "reauth_required";

  return (
    <div className="rounded-control border border-line px-3 py-2.5 space-y-2">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0" style={{ color: TEXT.muted }}>
          <PlugIcon size={ICON.sm} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] text-ink">{connection.label}</span>
            <StatusBadge
              state={status.state}
              label={CONNECTION_STATUS_LABEL[connection.status] ?? connection.status}
              icon={status.icon}
            />
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

          {/* WHAT CONNECTING MEANS, IN SENTENCES, BEFORE THE BUTTON. Shown while it is still a
              decision rather than after it has been made. */}
          {!connected ? (
            <ul className="mt-1.5 space-y-0.5">
              {connection.consent.map((line) => (
                <li key={line} className="flex items-start gap-1.5 text-[12px]" style={{ color: TEXT.muted }}>
                  <span className="mt-0.5 shrink-0">
                    <ShieldCheckIcon size={ICON.xs} />
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {/* AND THE EXACT LIST, SECOND. What was GRANTED, which may be less than was asked for. */}
          {connected && connection.scopes.length ? (
            <p className="mt-1 font-mono text-[11px] break-all" style={{ color: TEXT.muted }}>
              {connection.scopes.join("  ")}
            </p>
          ) : null}

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

      <div className="flex items-center gap-1.5">
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
          <button
            className={primaryBtn}
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
