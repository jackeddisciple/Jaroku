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
// SO: THE ITEM IS ADDRESSABLE AND THE HANDLER IS NOT BUILT. That is the honest half of the choice
// §20 offers, and this comment is the "say which" it asks for. What exists is a URL anybody can
// produce, paste and read; what does not exist is the code that receives one and opens the job.
//
// WHY THAT DIVISION AND NOT THE OTHER. The address is the half with a deadline: the moment somebody
// copies an id out of this product into a chat, the shape of what they copied is fixed by habit
// whether or not it was designed. The handler has no deadline — a link that parses and does nothing
// is what `deepLink.ts` already produces for `open`, and it logs rather than erroring, so a link
// pasted today is inert rather than broken. Building the receiver means switching the workspace
// first, which is a flow with its own confirmations (`WorkspaceSwitchLock`), and putting that on
// the end of this pass would be the largest untested path in it.
//
// THE WORKSPACE IS IN THE URL FOR EXACTLY THAT REASON. A link that named only the item would be
// unopenable by the person who receives it — work items are scoped, and a reader in the wrong
// workspace would get a refusal rather than a job. Carrying the workspace means the day the handler
// is written it has what it needs, and means a link is self-describing today.

import { parseDeepLink } from "./deepLink.ts";

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
  const link = parseDeepLink(raw);
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
