// The three groups, and why each gets different buttons.
//
// Secrets arrive three ways and each needs different verbs, so offering the same row of buttons to
// all of them would mean offering at least one button that cannot work:
//
//   MODEL PROVIDERS  user-pasted keys      rotate · test · reveal   they gate model availability,
//                                                                   and can be validated live
//   MANAGED          connector OAuth       reconnect ONLY           Jaroku does not own the
//                                                                   lifecycle; "rotate" would be a
//                                                                   button that writes a value the
//                                                                   far end has never heard of
//   CUSTOM           user-added, agent-read rotate · revoke · usage arbitrary consumers, so a
//                                                                   blast-radius view before any
//                                                                   destructive verb
//
// NO PRIMITIVES ARE INVENTED HERE. Rows are `ActionRow`, status is `Chip`, long names are
// `Truncate`, the empty states are `EmptyState`, and the buttons are the class strings in
// `buttons.ts`. That is the brief's instruction and it is also why this file is mostly wiring.

import { useState } from "react";

import { ActionRow } from "./ActionRow.tsx";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { KeyIcon, EyeIcon, RefreshIcon, XIcon, PlugIcon, CheckIcon } from "./panelIcons.tsx";
import { primaryBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { ICON, STATUS } from "../lib/tokens.ts";
import {
  fetchUsage,
  revealSecret,
  revokeSecret,
  rotateSecret,
  testSecret,
  type SecretSummary,
  type UsageSite,
} from "../lib/secrets.ts";
import { groupSecrets, holdForElevation, useSecretsStore } from "../store/secretsStore.ts";

/** Status as a chip, with a word in it — never colour alone. */
function StatusChip({ secret }: { secret: SecretSummary }) {
  const tone =
    secret.status === "valid" ? STATUS.ok : secret.status === "invalid" ? STATUS.error : STATUS.pending;
  if (!secret.configured) {
    return (
      <Chip size="sm" tone="faint" variant="outline">
        not configured
      </Chip>
    );
  }
  // `expiring` is computed from the date rather than trusted from the column, so a row that sat in
  // a client for ten minutes does not keep claiming it has a week left.
  const expiringSoon =
    secret.expiresAt !== null && Date.parse(secret.expiresAt) - Date.now() < 7 * 24 * 3_600_000;
  if (expiringSoon) {
    const days = Math.max(0, Math.ceil((Date.parse(secret.expiresAt!) - Date.now()) / 86_400_000));
    return (
      <Chip size="sm" color={STATUS.pending}>
        expires in {days}d
      </Chip>
    );
  }
  return (
    <Chip size="sm" color={tone}>
      {secret.status}
    </Chip>
  );
}

/**
 * The once-only display of a value.
 *
 * Shown at creation, and again on a deliberate reveal (ADR-035). Held in LOCAL state and dropped
 * when this unmounts — it is never put in the store, because a store is what devtools serialise.
 */
function ValueOnce({ value, onDone }: { value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-control border border-hair px-3 py-2">
      <p className="text-[11px] text-muted">
        Save this now. It is shown once — afterwards only a masked hint is stored, and the way back
        to a value is rotating it.
      </p>
      <code className="block break-all rounded-control bg-bg px-2 py-1.5 font-mono text-[12px] text-ink">
        {value}
      </code>
      <div className="flex items-center gap-2">
        <button
          className={secondaryBtn}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(
              () => setCopied(true),
              // A clipboard write can be refused by permissions policy. Saying so beats a button
              // that silently does nothing and a user who pastes the previous clipboard entry.
              () => setCopied(false),
            );
          }}
        >
          {copied ? <CheckIcon size={ICON.xs} /> : null} {copied ? "Copied" : "Copy"}
        </button>
        <button className={quietBtn} onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Rotate, and add — the same form, because rotating IS storing a new value under a known name. */
function ValueForm({
  label,
  busy,
  onSubmit,
  onCancel,
}: {
  label: string;
  busy: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex items-center gap-2 pt-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (value) onSubmit(value);
      }}
    >
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        placeholder={label}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="min-w-0 flex-1 rounded-control bg-bg px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-faint focus:shadow-focusring"
      />
      <button type="submit" className={primaryBtn} disabled={busy || !value}>
        {busy ? "Saving…" : "Save"}
      </button>
      <button type="button" className={quietBtn} onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

/**
 * Revoking, gated by blast radius.
 *
 * The server decides whether a typed confirmation is required — it is the only side that knows
 * what references the credential — so this renders the demand it makes rather than predicting it.
 * A client that guessed would eventually guess wrong in the permissive direction.
 */
function RevokeForm({
  name,
  needsTyping,
  busy,
  onConfirm,
  onCancel,
}: {
  name: string;
  needsTyping: boolean;
  busy: boolean;
  onConfirm: (confirm?: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  if (!needsTyping) {
    return (
      <div className="flex items-center gap-2 pt-1">
        <span className="text-[11px] text-muted">Revoke {name}?</span>
        <button className={primaryBtn} disabled={busy} onClick={() => onConfirm()}>
          {busy ? "Revoking…" : "Revoke"}
        </button>
        <button className={quietBtn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <form
      className="space-y-2 pt-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (typed === name) onConfirm(typed);
      }}
    >
      <p className="text-[11px] text-err">
        {name} is referenced by this workspace. Type its name to confirm — a quiet revoke breaks a
        deployed agent at three in the morning.
      </p>
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={name}
          className="min-w-0 flex-1 rounded-control bg-bg px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-faint focus:shadow-focusring"
        />
        <button type="submit" className={primaryBtn} disabled={busy || typed !== name}>
          {busy ? "Revoking…" : "Revoke"}
        </button>
        <button type="button" className={quietBtn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * What breaks if I revoke this.
 *
 * TWO SOURCES, SHOWN SEPARATELY AND LABELLED, because merging them would produce a number nobody
 * can act on: a static hit is a guess about code that may never run, and a runtime read is a fact
 * about code that did. "Three references" means something different when two of them are guesses.
 */
function UsageView({ sites }: { sites: UsageSite[] }) {
  const staticHits = sites.filter((s) => s.source === "static_scan");
  const runtime = sites.filter((s) => s.source === "runtime_read");
  if (!sites.length) {
    return (
      <p className="pt-1 text-[11px] text-faint">
        Nothing references this — no mention in any agent&rsquo;s current source, and no run has
        received it.
      </p>
    );
  }
  return (
    <div className="space-y-2 pt-1 text-[11px]">
      <div>
        <div className="text-faint">Referenced in source</div>
        {staticHits.length === 0 ? (
          <div className="text-faint">
            — none. A name built at runtime would not appear here even if it is used.
          </div>
        ) : (
          staticHits.map((s) => (
            <div key={`${s.agent_id}:${s.location}`} className="font-mono text-muted">
              · {s.location}
            </div>
          ))
        )}
      </div>
      <div>
        <div className="text-faint">Received by a run</div>
        {runtime.length === 0 ? (
          <div className="text-faint">
            — never. Code that has not run yet would not appear here either.
          </div>
        ) : (
          runtime.map((s) => (
            <div key={`rt:${s.agent_id}`} className="text-muted">
              · {s.hits} read{s.hits === 1 ? "" : "s"}, last {new Date(s.detected_at).toLocaleString()}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

type RowMode = "idle" | "rotate" | "revoke" | "revealed" | "usage";

function SecretRow({ secret, onChanged }: { secret: SecretSummary; onChanged: () => void }) {
  const [mode, setMode] = useState<RowMode>("idle");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSite[] | null>(null);
  const [needsTyping, setNeedsTyping] = useState(false);
  const setError = useSecretsStore((s) => s.setError);
  const setNotice = useSecretsStore((s) => s.setNotice);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const managed = secret.kind === "managed";

  const trailing = managed ? (
    // RECONNECT AND NOTHING ELSE. Rotating a connector token would write a value the provider has
    // never issued; revoking it would leave a connection row pointing at a credential that is gone.
    <button
      className={secondaryBtn}
      title="Run the connector's consent flow again"
      onClick={() => setNotice(`Reconnect ${secret.connectorId ?? "this connector"} from the Connections tab.`)}
    >
      <PlugIcon size={ICON.xs} /> Reconnect
    </button>
  ) : (
    <div className="flex items-center gap-1">
      {secret.kind === "provider_key" ? (
        <button
          className={quietBtn}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await testSecret(secret.name);
              setNotice(result.ok ? `${secret.name} works.` : (result.message ?? "That key was rejected."));
              onChanged();
            })
          }
        >
          Test
        </button>
      ) : null}
      {secret.configured ? (
        <button
          className={quietBtn}
          disabled={busy}
          title="Show the stored value once"
          onClick={() =>
            void run(async () => {
              const value = await revealSecret(secret.name);
              setRevealed(value);
              setMode("revealed");
            })
          }
        >
          <EyeIcon size={ICON.xs} /> Reveal
        </button>
      ) : null}
      <button className={quietBtn} disabled={busy} onClick={() => setMode(mode === "rotate" ? "idle" : "rotate")}>
        <RefreshIcon size={ICON.xs} /> {secret.configured ? "Rotate" : "Add"}
      </button>
      {secret.kind === "custom" ? (
        <button
          className={quietBtn}
          disabled={busy}
          title="What breaks if I revoke this"
          onClick={() => {
            if (mode === "usage") {
              setMode("idle");
              return;
            }
            void run(async () => {
              setUsage(await fetchUsage(secret.name));
              setMode("usage");
            });
          }}
        >
          Usage
        </button>
      ) : null}
      {secret.configured ? (
        <button
          className={quietBtn}
          disabled={busy}
          onClick={() => {
            setNeedsTyping(false);
            setMode(mode === "revoke" ? "idle" : "revoke");
          }}
        >
          <XIcon size={ICON.xs} /> Revoke
        </button>
      ) : null}
    </div>
  );

  return (
    <ActionRow
      kind="connect"
      state={secret.status === "invalid" ? "error" : secret.configured ? "done" : "pending"}
      hideVerb
      icon={<KeyIcon size={ICON.sm} />}
      object={
        <Truncate className="font-mono text-ink">
          {secret.name}
        </Truncate>
      }
      badges={
        <div className="flex items-center gap-1">
          <StatusChip secret={secret} />
          {secret.maskedHint ? (
            <Chip size="sm" tone="faint" mono>
              {secret.maskedHint}
            </Chip>
          ) : null}
          {/* Scope, so somebody knows an edit here is global rather than local to one agent. */}
          <Chip size="sm" tone="faint" variant="bare">
            {secret.scope === "agent" ? `agent: ${secret.agentId?.slice(0, 8) ?? "?"}` : "workspace"}
          </Chip>
        </div>
      }
      detail={
        <span className="text-faint">
          {secret.lastUsedAt ? `last used ${new Date(secret.lastUsedAt).toLocaleString()}` : "never used"}
          {secret.rotatedAt ? ` · rotated ${new Date(secret.rotatedAt).toLocaleDateString()}` : ""}
          {managed && secret.connectorId ? ` · via ${secret.connectorId} connector` : ""}
        </span>
      }
      trailing={trailing}
    >
      {mode === "rotate" ? (
        <ValueForm
          label={secret.configured ? "New value" : "Value"}
          busy={busy}
          onCancel={() => setMode("idle")}
          onSubmit={(value) =>
            void run(async () => {
              // The same hold the add form uses. A rotation is a credential somebody has just
              // pasted out of a provider console, and it is not recoverable once this row unmounts
              // behind the lock screen — so the attempt is parked and finished after unlocking.
              const applied = await holdForElevation(`rotate ${secret.name}`, async () => {
                await rotateSecret(secret.name, value);
              });
              setMode("idle");
              if (applied) setNotice(`${secret.name} updated.`);
              onChanged();
            })
          }
        />
      ) : null}
      {mode === "revoke" ? (
        <RevokeForm
          name={secret.name}
          needsTyping={needsTyping}
          busy={busy}
          onCancel={() => setMode("idle")}
          onConfirm={(confirm) =>
            void run(async () => {
              try {
                await revokeSecret(secret.name, confirm);
              } catch (err) {
                // The server refuses with 409 when the credential is referenced. That refusal IS
                // the blast-radius check, so it is turned into the typed-confirmation form rather
                // than shown as an error the user cannot act on.
                if ((err as { status?: number }).status === 409 && !confirm) {
                  setNeedsTyping(true);
                  return;
                }
                throw err;
              }
              setMode("idle");
              setNotice(`${secret.name} revoked.`);
              onChanged();
            })
          }
        />
      ) : null}
      {mode === "usage" && usage !== null ? <UsageView sites={usage} /> : null}
      {mode === "revealed" && revealed !== null ? (
        <ValueOnce
          value={revealed}
          onDone={() => {
            setRevealed(null);
            setMode("idle");
          }}
        />
      ) : null}
    </ActionRow>
  );
}

function Group({
  title,
  secrets,
  empty,
  onChanged,
}: {
  title: string;
  secrets: SecretSummary[];
  empty: string;
  onChanged: () => void;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[10px] uppercase tracking-wide text-faint">{title}</h3>
      {secrets.length === 0 ? (
        <p className="px-1 text-[11px] text-faint">{empty}</p>
      ) : (
        secrets.map((s) => <SecretRow key={`${s.name}:${s.agentId ?? ""}`} secret={s} onChanged={onChanged} />)
      )}
    </section>
  );
}

export function SecretsList({ onChanged }: { onChanged: () => void }) {
  const secrets = useSecretsStore((s) => s.secrets);
  const loaded = useSecretsStore((s) => s.loaded);
  const groups = groupSecrets(secrets);

  // `loaded`, not `secrets.length` — before the first response lands, "nothing configured" and
  // "we have not been told yet" look identical, and rendering the first flashes an empty state at
  // somebody who has six credentials.
  if (!loaded) return null;

  if (secrets.length === 0) {
    return (
      <EmptyState
        title="No credentials yet"
        hint="Add a model provider key to start building, or any credential your agents read."
        icon={KeyIcon}
        size="inline"
      />
    );
  }

  return (
    <div className="space-y-4">
      <Group
        title="Model providers"
        secrets={groups.providers}
        empty="No provider keys yet — a model needs one before it can run."
        onChanged={onChanged}
      />
      <Group
        title="Managed (from connectors)"
        secrets={groups.managed}
        empty="Nothing connected. Connector credentials appear here automatically."
        onChanged={onChanged}
      />
      <Group
        title="Custom"
        secrets={groups.custom}
        empty="Nothing yet. Credentials your agents read by name live here."
        onChanged={onChanged}
      />
    </div>
  );
}
