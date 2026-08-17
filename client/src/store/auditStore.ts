// What has been done to this workspace, and by whom.
//
// Full-snapshot discipline like every other channel's store: an `audit` message replaces the list
// rather than merging into it. There is nothing to merge — the log is append-only server-side and
// this is a read of its most recent rows, so two answers assembled together could only produce a
// list ordered by when each half arrived.
//
// THE ROWS NAME PEOPLE, which is why this store is workspace-scoped and reset on a switch like the
// member list beside it: "who revealed ANTHROPIC_API_KEY", "who overrode the secret scan", "who
// removed whom". Held across a switch it would show one workspace's decisions under another's name.

import { create } from "zustand";

export interface AuditEntry {
  id: number;
  workspace_id: string | null;
  actor_user_id: string | null;
  /** `member.invited`, `secrets.revealed`, `github.override`, `workspace.export_requested`, … */
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  created_at: string;
}

interface AuditState {
  entries: AuditEntry[];
  loaded: boolean;
  error: string | null;

  setEntries: (entries: unknown[]) => void;
  setError: (message: string | null) => void;
}

export const useAuditStore = create<AuditState>((set) => ({
  entries: [],
  loaded: false,
  error: null,

  setEntries: (entries) => set({ entries: entries as AuditEntry[], loaded: true, error: null }),
  setError: (error) => set({ error }),
}));
