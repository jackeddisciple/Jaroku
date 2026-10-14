// The model an agent was "Applied" on becomes the composer's run model when that agent is picked
// (server migration 088, the trace panel's Apply, 2026-10-14).
//
// ONLY ON A CHANGE: when the agent picked changes, or the picked agent's applied model does — never
// on an unrelated snapshot, which would undo a model somebody chose by hand a moment ago. A model the
// catalogue does not offer is left alone; `pickRunModel` keeps the pair one that can run.

import { useBuildStore } from "../store/buildStore.ts";
import { useProviderStore } from "../store/providerStore.ts";
import { useUiStore } from "../store/uiStore.ts";

const appliedModel = (s: ReturnType<typeof useBuildStore.getState>): string | null =>
  s.agents.find((a) => a.agent_id === s.activeAgentId)?.default_model ?? null;

useBuildStore.subscribe((s, prev) => {
  const model = appliedModel(s);
  if (!model) return;
  if (s.activeAgentId === prev.activeAgentId && model === appliedModel(prev)) return;
  if (!useProviderStore.getState().models.some((m) => m.id === model)) return;
  if (useUiStore.getState().model !== model) useUiStore.getState().setModel(model);
});
