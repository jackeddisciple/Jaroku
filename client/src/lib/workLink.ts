// §20's addressable work item: the URL shape `deepLink.ts` reserved, spent on the resource it was
// reserved for.
//
// §20: "`deepLink.ts` already CLAIMS `jaroku://open?workspace=<id>&resource=<path>` and
// deliberately leaves it unimplemented, with a comment saying that claiming the name now means the
// day somebody builds it is not the day they discover it was spent. A WORK ITEM IS THAT RESOURCE.
// Give every work item an addressable identity so a failed job can be pasted to a teammate.
// Whether you implement the handler here or only make the item addressable, SAY WHICH — but do not
// invent a second URL shape beside the one already reserved."
//
// THE ITEM IS ADDRESSABLE AND THE HANDLER IS BUILT — `openWorkLink` below, called from `main.tsx`
// when the operating system hands this window a `jaroku://` URL. It was not, at first: the copy chip
// put this link on the clipboard and opening it did nothing at all, so "paste a failed job to a
// teammate", the whole reason the address exists, led nowhere. Opening one switches workspace first
// when the job is in another one the person belongs to, through the ordinary `switchWorkspace` with
// its own lock, and says so when they do not belong to it.
//
// THE WORKSPACE IS IN THE URL FOR EXACTLY THAT REASON. A link that named only the item would be
// unopenable by the person who receives it — work items are scoped, and a reader in the wrong
// workspace would get a refusal rather than a job. Carrying the workspace means the day the handler
// is written it has what it needs, and means a link is self-describing today.

import { parseDeepLink, type DeepLink } from "./deepLink.ts";
import { sendLoadWorkItem, switchWorkspace } from "./socket.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useUiStore } from "../store/uiStore.ts";

/**
 * The resource prefix. One word, and it is the CHANNEL's name rather than the table's.
 *
 * `work` AND NOT `work_items`, because a URL is a public surface and a table name is not. The
 * channel is already called `work`, the tab is the Cockpit, and the resource somebody is sharing is
 * a job — `work/<id>` reads as all three and commits to none of the schema.
 */
export const WORK_RESOURCE = "work";

/**
 * A link to one job, in the shape `deepLink.ts` reserved.
 *
 * BOTH VALUES ARE ENCODED. Neither a workspace id nor a work item id contains a character that
 * needs it today — both are uuids — but a URL builder that only works for the inputs it was written
 * against is one that breaks the day an id gains a hyphenated suffix, and the breakage is a link
 * somebody has already pasted.
 */
export function workLink(workspaceId: string, itemId: string): string {
  const workspace = encodeURIComponent(workspaceId);
  const resource = encodeURIComponent(`${WORK_RESOURCE}/${itemId}`);
  return `jaroku://open?workspace=${workspace}&resource=${resource}`;
}

/**
 * Read one back — which is the half that IS implemented, because it is what makes the shape a
 * contract rather than a string this file happens to build.
 *
 * IT GOES THROUGH `parseDeepLink` RATHER THAN A REGEX, so every refusal that module already makes
 * applies here: the wrong scheme, an unknown action, a traversal segment, a malformed escape. §20
 * says not to invent a second URL shape, and parsing it a second way would be exactly that — a
 * second reading of one shape, which is how two readers start disagreeing about what is valid.
 *
 * `null` FOR ANYTHING THAT IS NOT ONE OF THESE, with no distinction between the ways it can fail,
 * for the reason `parseDeepLink` gives: none of them is an instruction this application understands
 * and there is nothing different worth doing about any of them.
 */
export function parseWorkLink(raw: unknown): { workspaceId: string; itemId: string } | null {
  return workLinkFrom(parseDeepLink(raw));
}

/** The same reading, of a link `parseDeepLink` has already parsed — what the shell's event carries. */
export function workLinkFrom(link: DeepLink | null): { workspaceId: string; itemId: string } | null {
  if (!link || link.action !== "open") return null;
  const workspaceId = link.params["workspace"];
  const resource = link.params["resource"];
  if (!workspaceId || !resource) return null;
  const [kind, ...rest] = resource.split("/");
  if (kind !== WORK_RESOURCE) return null;
  const itemId = rest.join("/");
  // A RESOURCE WITH NO ID IS NOT A WORK LINK. `work/` alone parses as a path and names nothing,
  // and answering with an empty id would hand a caller a lookup that cannot fail usefully.
  return itemId ? { workspaceId, itemId } : null;
}

/**
 * Open the job a link names: in this workspace, or — if the person belongs to it — in the one it
 * names, switching there first.
 *
 * NOTHING IS BELIEVED FROM THE LINK. The workspace has to be one the session already lists, and the
 * job is asked for under that workspace's scope like any other read, so a link to somebody else's
 * job answers "no such job" rather than showing it. A session that is not ready yet (the link
 * started the application) waits until it is.
 */
export function openWorkLink(link: { workspaceId: string; itemId: string }): void {
  const session = useSessionStore.getState();
  if (session.status !== "ready") {
    const stop = useSessionStore.subscribe((s) => {
      if (s.status !== "ready") return;
      stop();
      openWorkLink(link);
    });
    return;
  }
  if (!session.workspaces.some((w) => w.id === link.workspaceId)) {
    useUiStore.getState().showToast("That job is in a workspace you are not a member of", "err");
    return;
  }
  const switching = session.workspaceId !== link.workspaceId;
  if (switching) switchWorkspace(link.workspaceId);
  useUiStore.getState().openCockpitAtItem(link.itemId);
  // In the same workspace the socket is already open, and the Cockpit may already be mounted — so
  // the job is asked for now rather than left to an effect that has already run.
  if (!switching) {
    useUiStore.getState().takeCockpitItemIntent();
    sendLoadWorkItem(link.itemId);
  }
}
