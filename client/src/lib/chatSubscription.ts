// The plan a chat message rides, for every way a chat turn is sent.
//
// THE COMPOSER ASKED THIS AND THE TURN'S OWN CONTROLS DID NOT. Regenerate, retry, "I just wanted to
// ask" and edit-and-fork went to the server with no subscription, so a conversation held on somebody's
// own plan was answered again on an API key — the one crossing the two credential systems never make.
//
//   npm run test:chat-model

import {
  EFFORT_LEVELS, FALLBACK_SETTINGS, useComposerSettingsStore, type Effort,
} from "../store/composerSettingsStore.ts";
import { useProviderStore } from "../store/providerStore.ts";
import { useThreadStore } from "../store/threadStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { subscriptionEffort } from "./effortLevels.ts";
import { canRunLocally } from "./providerTurn.ts";

/** What a chat command carries when a plan answers it. */
export interface ChatSubscription {
  provider: string;
  model: string | null;
  effort: Effort | null;
}

/**
 * The subscription a chat message rides, or null when Chat has no connected plan on this machine.
 *
 * `modelId` IS "REGENERATE WITH <model>": that model's own provider has to be connected. `level` is the
 * effort to ask for — the composer's when it has one, else the conversation's setting — clamped to what
 * the model and the provider accept, and null when the model takes none.
 */
export function chatSubscriptionFor(opts: { modelId?: string; level?: string | null } = {}): ChatSubscription | null {
  if (!canRunLocally()) return null;
  const { models, subscriptions } = useProviderStore.getState();
  const ui = useUiStore.getState();
  const entry = models.find((m) => m.id === (opts.modelId ?? ui.chatModel));
  const provider = entry?.provider ?? (opts.modelId ? null : ui.chatProvider);
  if (!provider) return null;
  const row = subscriptions.find((s) => s.provider === provider);
  if (!row?.connected) return null;
  const level = EFFORT_LEVELS.find((l) => l === opts.level) ?? conversationEffort();
  return { provider, model: entry?.id ?? null, effort: subscriptionEffort(entry, row.effortLevels, level) };
}

/** The effort the open conversation is set to — what a control with no composer of its own asks for. */
function conversationEffort(): Effort {
  const threadId = useThreadStore.getState().activeThreadId;
  return (useComposerSettingsStore.getState().byConversation[threadId ?? "__none"] ?? FALLBACK_SETTINGS).reasoning_effort;
}
