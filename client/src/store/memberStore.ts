// Who is in this workspace, and who has been asked.
//
// Full-snapshot discipline, like `mcpStore`, `providerStore` and `deployStore`: every
// `members` message replaces the list rather than merging into it, so this can never hold a
// half-applied view of who has access.
//
// `inviteLink` is the one thing here that is not a snapshot, and it is the only credential
// this client ever receives besides the deploy bearer token. It is shown once, kept in memory,
// and never persisted — the server stores only a hash, so this message is genuinely the only
// chance anybody has to see it. Dismissing it loses it, and the UI says so.

import { create } from "zustand";

export interface Member {
  workspace_id: string;
  user_id: string;
  role: string;
  created_at: string;
  email: string;
  display_name: string | null;
}

export interface Invite {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  created_at: string;
}

export interface InviteLink {
  email: string;
  role: string;
  token: string;
  expiresAt: string;
}

interface MemberState {
  members: Member[];
  invites: Invite[];
  loaded: boolean;
  /** Shown once, never stored. See the header. */
  inviteLink: InviteLink | null;
  error: string | null;
  notice: string | null;

  setMembers: (members: unknown[], invites: unknown[]) => void;
  setInviteLink: (link: InviteLink) => void;
  dismissInviteLink: () => void;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  reset: () => void;
}

const EMPTY = {
  members: [] as Member[],
  invites: [] as Invite[],
  loaded: false,
  inviteLink: null as InviteLink | null,
  error: null as string | null,
  notice: null as string | null,
};

export const useMemberStore = create<MemberState>((set) => ({
  ...EMPTY,

  setMembers: (members, invites) =>
    set({ members: members as Member[], invites: invites as Invite[], loaded: true, error: null }),

  setInviteLink: (inviteLink) => set({ inviteLink, error: null }),
  dismissInviteLink: () => set({ inviteLink: null }),
  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),

  /**
   * Everything, back to nothing.
   *
   * Called on a workspace switch. This store holds EMAIL ADDRESSES of the previous workspace's
   * members — a stale one bleeding across a switch is a cross-tenant leak in the UI even when
   * the server behaved perfectly, which is exactly the case the spec calls out.
   */
  reset: () => set({ ...EMPTY }),
}));
