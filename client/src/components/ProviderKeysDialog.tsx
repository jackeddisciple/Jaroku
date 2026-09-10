// The provider keys, as a dialog of their own.
//
// THEY WERE A POPOVER UNDER THE TOP BAR'S PROVIDER CHIP, and the top bar is gone: the middle panel
// carries no header any more. What the popover said is kept as it was — which providers have a key,
// who pays for Jaroku's own thinking, and the door to Secrets — and the way in that remains,
// "Provider keys" in the account menu, opens it here, centred over the application the way the
// workspace panel is. See lib/dialog for what makes an overlay a dialog.

import { useEffect } from "react";
import { providerLabelOf, useProviderStore } from "../store/providerStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { sendSetOwnKeyForPlatform } from "../lib/socket.ts";
import { useCanRun } from "../lib/useCapability.ts";
import { useDialog } from "../lib/dialog.ts";
import { ProviderMark } from "../lib/icons.tsx";
import { ICON, TYPE } from "../lib/tokens.ts";
import { Icon } from "../lib/icons/registry.ts";
import { KeyIcon } from "./panelIcons.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { CheckboxField } from "./Checkbox.tsx";

/** The id `aria-labelledby` points at, and the id on the heading it names — one constant, one pair. */
const PROVIDER_KEYS_LABEL_ID = "provider-keys-title";

/**
 * Which providers this workspace has a key for — and the one door to changing that.
 *
 * IT USED TO BE A PLACE TO PASTE ONE, AND THAT WAS THE HOLE. The form here sent the key over the
 * WebSocket, and elevation travels on a request header that a WebSocket cannot carry: the passcode
 * gate the whole Secrets surface is built on could be walked around by opening this popover. §5.1
 * had already asked for one home for a credential and named the cost of two — two rotation paths,
 * two validation paths — and this was the path that classified nothing, stored no mask, and wrote
 * no audit row, so a key added here landed in the Secrets tab's Custom group.
 *
 * So it reads and does not write. What it keeps is the useful half: it is still where you find out
 * whether a provider is connected, and it is also where you are sent to the tab that can change it.
 */
export function ProviderKeysDialog() {
  // Open state lives in uiStore, not here, because the account menu in the sidebar opens it.
  const open = useUiStore((s) => s.providerPanelOpen);
  const setOpen = useUiStore((s) => s.setProviderPanel);
  const setRightTab = useUiStore((s) => s.setRightTab);
  const providers = useProviderStore((s) => s.providers);
  const models = useProviderStore((s) => s.models);
  const ownKeyForPlatform = useProviderStore((s) => s.ownKeyForPlatform);
  // The one provider this preference can spend: planning, generation, the fix loop, explain and
  // the judge are Anthropic-only, so an OpenAI key opted in would buy the workspace nothing.
  const anthropicReady = providers.some((p) => p.id === "anthropic" && p.configured);
  const canManageProviders = useCanRun("setOwnKeyForPlatform");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // CALLED ABOVE THE EARLY RETURN, for WorkspacePanel's reason: a hook that stops being called on
  // close is a hook whose cleanup never runs, and the cleanup is what gives the focus back.
  const { ref: card, dialogProps } = useDialog(open, PROVIDER_KEYS_LABEL_ID);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-ink/40 p-8"
      // Dismissed by the backdrop as well as by Escape. Nothing here is typed, so nothing is lost.
      onMouseDown={(e) => {
        if (!card.current?.contains(e.target as Node)) setOpen(false);
      }}
    >
      <div
        ref={card}
        {...dialogProps}
        className="mt-16 w-[440px] max-w-full animate-slide-in rounded-lg border border-edge bg-elevated p-3 shadow-overlay focus-visible:outline-none motion-reduce:animate-none"
      >
        <div className="flex items-center">
          <span id={PROVIDER_KEYS_LABEL_ID} className={TYPE.sectionLabel}>Provider keys</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            title="Close (Esc)"
            aria-label="Close (Esc)"
            className="ml-auto rounded-control px-1.5 py-1 text-faint transition-colors hover:bg-active active:bg-chrome hover:text-ink"
          >
            <Icon.workspace.close size={ICON.sm} />
          </button>
        </div>
        <p className="mt-1 text-tiny leading-[1.55] text-faint">
          Kept in Secrets with every other credential, behind the passcode. Never logged, never
          sent back to this page.
        </p>
        <div className="mt-2.5 space-y-2">
          {providers.map((p) => (
            <div key={p.id} className="flex items-center gap-2">
              <ProviderMark provider={p.id} size={12} />
              <span className="text-caption text-ink">{providerLabelOf(models, p.id)}</span>
              {p.configured ? (
                <StatusBadge state="ok" variant="outline" label="connected" icon={KeyIcon} />
              ) : (
                // DISABLED WITH A STATED REASON RATHER THAN ABSENT, the same rule the model
                // selector follows: a provider that vanishes reads as one the product does not
                // support.
                <span className="text-tiny text-faint">no key</span>
              )}
              {p.powers_jaroku && (
                <span className="ml-auto text-tiny text-faint">powers planning &amp; generation</span>
              )}
            </div>
          ))}
          {providers.length === 0 && (
            <p className="text-tiny text-faint">Not connected to the server.</p>
          )}
        </div>
        {/* WHO PAYS FOR JAROKU'S OWN THINKING, beside the row that says which provider does it.
            The server has accepted this command since BYOK shipped and nothing ever sent it, so
            the preference was permanently false and the Usage panel's note about it was
            unreachable — while the other branch of that note told people to "connect your own to
            run past" a ceiling, pointing at a control that did not exist.

            Disabled with a stated reason rather than hidden when there is no Anthropic key: that
            is the same refusal the server makes, made here so the answer arrives before the
            click rather than as an error strip after it. */}
        {/* §8.2 — "Connections tab / enter key" reaches this control from the other direction.
            `setOwnKeyForPlatform` is `provider:manage`, the admin's: it decides which of two
            credentials pays for planning and generation, and the person who connected the key is
            the one who knows whether their provider account should carry ours too.

            The `disabled` beside it stays, and the two are not the same thing. That one is about
            whether the control APPLIES — there is no Anthropic key for it to spend, so the
            server would refuse an admin too — and §8's rule is about who may use a control that
            does apply. A refusal everybody gets is a state; a refusal only some roles get is a
            permission, and only the second is absent. */}
        {canManageProviders && (
        <div className="mt-3 border-t border-hair pt-2.5">
          <CheckboxField
            align="start"
            checked={ownKeyForPlatform}
            disabled={!anthropicReady}
            onChange={() => sendSetOwnKeyForPlatform(!ownKeyForPlatform)}
          >
            Pay for planning &amp; generation with my Anthropic key
            <span className="block text-faint">
              {anthropicReady
                ? "Off by default — Jaroku's own calls bill to us unless you say otherwise."
                : "Needs an Anthropic key in this workspace — that is the key this would spend."}
            </span>
          </CheckboxField>
        </div>
        )}

        <button
          type="button"
          className="mt-2.5 w-full rounded-control border-t border-hair pt-2.5 text-left text-caption text-muted transition-colors duration-fast hover:text-ink"
          onClick={() => {
            setRightTab("secrets");
            setOpen(false);
          }}
        >
          Add or rotate a key in Secrets →
        </button>
      </div>
    </div>
  );
}
