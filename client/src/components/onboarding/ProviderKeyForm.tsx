// One provider's credential field — the only place in the client a model API key is typed.
//
// Shared by the onboarding step and the top bar's provider popover on purpose. A second copy
// would be a second set of promises about what happens to the key, and those two copies would
// drift the first time one of them was adjusted.
//
// Modelled on McpPanel's credential field, which solved the same problem first: masked input,
// and a footnote that says WHERE the value goes rather than reassuring that it is safe. "Safe"
// is a claim; "written to runtime/.env, which is gitignored" is a fact the user can check.
//
// Test and Save are two buttons and two commands. Testing writes nothing — a key is proven
// before it is stored, not after, and a button labelled "Test connection" that quietly put a
// credential on disk would be lying about itself.

import { useEffect, useState } from "react";
import { sendSetProviderKey, sendTestProviderKey } from "../../lib/socket.ts";
import { useProviderStore } from "../../store/providerStore.ts";
import type { ProviderStatus } from "../../types.ts";
import { ICON } from "../../lib/tokens.ts";
import { primaryBtn, quietBtn, secondaryBtn } from "../buttons.ts";
import { AlertTriangleIcon, CheckIcon, KeyIcon, LoaderIcon } from "../panelIcons.tsx";
import { StatusBadge, StatusDot } from "../StatusBadge.tsx";

/** Where a key is created. Linked rather than described — nobody should have to go find it. */
const KEY_PAGE: Record<string, { href: string; label: string }> = {
  anthropic: { href: "https://console.anthropic.com/settings/keys", label: "Anthropic Console" },
  openai: { href: "https://platform.openai.com/api-keys", label: "OpenAI Platform" },
};

export function ProviderKeyForm({
  provider,
  onSaved,
  saveLabel = "Save & continue",
  autoFocus = false,
  flush = false,
}: {
  provider: ProviderStatus;
  /** Called once the server confirms the key is stored. */
  onSaved?: () => void;
  saveLabel?: string;
  /**
   * Drop the form's own card.
   *
   * It draws one because in the top bar's popover it is a free-standing block on a flat panel.
   * Onboarding opens it INSIDE a provider card, and a bordered card immediately inside another
   * bordered card is the box-in-a-box the whole step was rewritten to get rid of. A hairline
   * above it says "this belongs to the card above" without drawing a second one.
   */
  flush?: boolean;
  /**
   * Off by default, because the settings panel renders one of these PER PROVIDER — and with
   * autofocus on, opening it moved the caret to whichever field happened to mount last. It is
   * on where a form is the thing the user just asked for: one expanded card in onboarding.
   */
  autoFocus?: boolean;
}) {
  const [key, setKey] = useState("");
  // The exact key a test succeeded for. Editing the field after a green tick must take the
  // Save button back — otherwise a successful test for one string would authorise storing a
  // different one.
  const [provenKey, setProvenKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const testing = useProviderStore((s) => Boolean(s.testing[provider.id]));
  const testResult = useProviderStore((s) => s.testResult);
  const error = useProviderStore((s) => s.error);
  const result = testResult?.provider === provider.id ? testResult : null;

  useEffect(() => {
    if (result?.ok) setProvenKey(key);
    // Only when a verdict lands, never on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // The server answers a store with a fresh snapshot, so `configured` flipping true IS the
  // confirmation — there is no separate "saved" event to wait for, and inventing one would
  // mean the UI could claim success the server never reported.
  useEffect(() => {
    if (saving && provider.configured) {
      setSaving(false);
      setKey("");
      setProvenKey(null);
      onSaved?.();
    }
  }, [saving, provider.configured, onSaved]);

  // A refused write comes back on the same channel as an error. Without this the button spins
  // forever on a key the .env format cannot store faithfully.
  useEffect(() => {
    if (error) setSaving(false);
  }, [error]);

  const typed = key.trim();
  const proven = typed.length > 0 && typed === provenKey;
  const page = KEY_PAGE[provider.id];

  const save = () => {
    if (!typed) return;
    setSaving(true);
    sendSetProviderKey(provider.id, typed);
  };

  return (
    <div
      className={
        flush
          ? "border-t border-hair pt-3"
          : "rounded-card border border-edge bg-panel p-3 shadow-raised"
      }
    >
      <div className="flex items-center gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          className="min-w-0 flex-1 rounded-control bg-bg px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-faint focus:shadow-focusring"
          placeholder={provider.id === "anthropic" ? "sk-ant-…" : "sk-…"}
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            // A new value has not been proven, whatever the last verdict said.
            setProvenKey(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && typed && !testing) {
              if (proven) save();
              else sendTestProviderKey(provider.id, typed);
            }
          }}
        />
        <button
          type="button"
          className={secondaryBtn}
          disabled={!typed || testing}
          onClick={() => sendTestProviderKey(provider.id, typed)}
          title="Ask the provider whether this key authenticates. Nothing is written, and the check is free."
        >
          {testing ? <LoaderIcon size={ICON.xs} /> : <KeyIcon size={ICON.xs} />}
          {testing ? "testing…" : "Test connection"}
        </button>
        <button
          type="button"
          className={primaryBtn}
          disabled={!proven || saving}
          onClick={save}
          title={
            proven
              ? "Write this key to runtime/.env"
              : "Test the key first — or save it without testing, below"
          }
        >
          {saving ? "saving…" : saveLabel}
        </button>
      </div>

      {/* The verdict. A failure names what the provider said, which is what makes it actionable
          — "rejected" alone sends people to re-copy a key that was fine. */}
      {result && (
        <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-[1.5]">
          {result.ok ? (
            <>
              <span className="mt-[2px] shrink-0"><StatusDot state="ok" icon={CheckIcon} size={ICON.xs} /></span>
              <span className="text-ok">This key works. Nothing has been written yet — press {saveLabel}.</span>
            </>
          ) : (
            <>
              <span className="mt-[2px] shrink-0"><StatusDot state="error" icon={AlertTriangleIcon} size={ICON.xs} /></span>
              <span className="text-err">{result.message ?? "That key was rejected."}</span>
            </>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-[11px] leading-[1.5] text-err">{error}</p>}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        {page && (
          <a
            href={page.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[11px] text-muted underline decoration-hair underline-offset-2 transition-colors hover:text-ink"
          >
            Create a key on the {page.label} ↗
          </a>
        )}
        {/* The explicit way past a test. Quiet, because testing is one click and free, but
            present — a provider having an outage should not be able to block setup. */}
        {!proven && (
          <button type="button" className={`${quietBtn} !px-0 !text-[11px]`} disabled={!typed || saving} onClick={save}>
            save without testing
          </button>
        )}
        {provider.configured && (
          <span className="ml-auto">
            <StatusBadge
              state="ok"
              variant="outline"
              label="key stored"
              icon={KeyIcon}
              title={`Read from ${provider.env_key} in runtime/.env. Jaroku never displays it.`}
            />
          </span>
        )}
      </div>

      {/* Where it goes, in the same words the MCP panel uses one screen away. */}
      <p className="mt-2 text-[11px] leading-[1.5] text-faint">
        Written to <span className="font-mono text-muted">runtime/.env</span> as{" "}
        <span className="font-mono text-muted">{provider.env_key}</span>, which is gitignored and
        read only by the Jaroku server process. It is never logged, never written into a generated
        project, and never sent back to this page.
      </p>
    </div>
  );
}
