// I4 and I7: call sites name actions, and the registry has no dead entries and no missing ones.
//
// BOTH DIRECTIONS, because each one alone permits a registry nobody trusts.
//
//   A KEY WITH NO CALL SITE is a mark somebody added and never wired, or wired and later removed.
//   A registry that accumulates those is one where "is this used?" costs a grep, which is the
//   moment people stop reading it and start adding beside it.
//
//   A CONTROL WITH NO KEY is the failure the registry exists to prevent: a component importing
//   `GitForkIcon` directly. It renders correctly and it is invisible until the day "fork" should
//   look different everywhere and looks different in eight places out of nine.
//
// AND THE THIRD LIST IS SPELLED OUT HERE. The keys icons_integration §5 and §6 name are written
// out below rather than derived from the manifest — a table that checked itself would pass just as
// happily with a row deleted.
//
//   npm run test:icon-registry

import { check, done, manifestKeys, read, sourceFiles } from "./harness.ts";
import { ICON_KEYS } from "./registry.ts";

const manifestSource = read("src/lib/icons/manifest.ts");
const entries = manifestKeys(manifestSource);
const keys = entries.map((e) => e.key);

const files = sourceFiles().filter(
  (f) => !f.includes(".test.") && !f.startsWith("src/lib/icons/"),
);
const bodies = new Map<string, string>(files.map((f) => [f, read(f)]));
const all = [...bodies.values()].join("\n");

console.log("\nthe registry agrees with the manifest it is built from");
{
  check("every manifest key is exported by the registry",
    keys.every((k) => ICON_KEYS.includes(k)),
    keys.filter((k) => !ICON_KEYS.includes(k)).join(", "));
  check("...and the registry has nothing the manifest does not",
    ICON_KEYS.length === keys.length, `${ICON_KEYS.length} vs ${keys.length}`);
}

console.log("\nno component reaches past the registry into generated/");
{
  // I4's mechanical half. `registry.ts` is the only file allowed to import the barrel, and it is
  // excluded from `files` above.
  let direct = 0;
  for (const [file, text] of bodies) {
    if (/from ["'][^"']*icons\/generated/.test(text)) {
      direct++;
      console.log(`  FAIL ${file} imports a generated mark directly`);
    }
  }
  check("no direct import of a generated component", direct === 0, `${direct} file(s)`);
}

console.log("\nevery registry key is used somewhere");
{
  const unused = keys.filter((k) => !new RegExp(`Icon\\.${k.replace(".", "\\.")}\\b`).test(all));
  for (const k of unused) console.log(`  FAIL ${k} has no call site`);
  check(`all ${keys.length} keys are referenced`, unused.length === 0, `${unused.length} unused`);
}

console.log("\n...and every key the specification names exists");
{
  // icons_integration §5 and §6, spelled out. 134 of them — the document's header says 135 and its
  // own two tables say 86 and 48, which is 134: `agents.new` is printed twice, shared between the
  // sidebar and the Agents grid, and counted twice in the header.
  const SPECIFIED = [
    // §5 sidebar rail, sidebar panel, right panel rail
    "nav.threads", "nav.agents", "nav.cockpit", "nav.inbox", "nav.activity", "nav.providerKeys",
    "workspace.switcherClosed", "workspace.switcherOpen", "agents.search", "agents.filter",
    "agents.new", "auth.signOut",
    "panel.agent", "panel.graph", "panel.trace", "panel.evals", "panel.mcp", "panel.connections",
    "panel.deploy", "panel.secrets", "panel.github", "panel.usage",
    // §5 threads, agents, agent detail, cockpit, composer
    "threads.refresh", "threads.new", "threads.archive", "threads.restore",
    "agents.refresh", "agents.filterGrid", "agents.viewGrid", "agents.viewTable",
    "agents.searchGrid", "agents.newThread", "agents.fork", "agents.more", "agents.restore",
    "agentDetail.rename", "agentDetail.export", "agentDetail.copy", "agentDetail.publishVersion",
    "agentDetail.restoreVersion",
    "cockpit.refresh", "cockpit.openConversation", "cockpit.agentMore", "cockpit.closeDetail",
    "cockpit.copyJobId",
    "composer.attach", "composer.expand", "composer.more", "composer.mic", "composer.send",
    // §5 inbox, activity, usage, connections, secrets, github, deploy, evals, trace, workspace, global
    "inbox.refresh", "inbox.laneInbox", "inbox.laneAlerts", "inbox.lanePermissions",
    "inbox.laneProposals", "inbox.laneSnoozed", "inbox.dismiss", "inbox.undo",
    "activity.dateRange", "activity.filterKind",
    "usage.exportCsv", "connections.disconnect", "secrets.reveal", "secrets.copy",
    "github.syncMore", "github.openPullRequest", "deploy.cancel", "deploy.buildLog",
    "evals.addExample", "evals.importCsv", "evals.deleteDataset", "evals.renameDataset",
    "evals.editRubric", "evals.revertRubric", "evals.clearComparison", "evals.prevResponse",
    "evals.nextResponse",
    "trace.pause", "trace.resume", "trace.stop",
    "workspace.close", "workspace.removeMember", "workspace.revokeInvite",
    "global.clearSearch", "global.clearFilter", "global.dismissNotice",
    // §6
    "auth.signIn", "auth.openJaroku", "topbar.deploy", "topbar.dryRun", "composer.addKey",
    "threadsFilter.all", "threadsFilter.needsYou", "threadsFilter.running", "threadsFilter.recent",
    "threadsFilter.archived",
    "cockpitFilter.mine", "cockpitFilter.everyones", "cockpitFilter.all",
    "cockpitFilter.showEverything", "cockpitFilter.showEveryAgent",
    "cockpitWork.openTrace", "cockpitWork.retry", "cockpitWork.stop",
    "cockpitGate.dispatch", "cockpitGate.cancel",
    "fleet.logs", "fleet.reconnect", "fleet.kill",
    "agentDetail.grantTool", "deploy.connectRailway", "deploy.deployAnother", "github.connect",
    "connections.save", "mcp.connectServer", "evals.run", "evals.cancel", "graph.retry",
    "workspaceTab.general", "workspaceTab.members", "workspaceTab.audit", "workspaceTab.billing",
    "workspaceTab.data", "workspaceTab.account",
    "workspace.invite", "workspace.newWorkspace", "workspace.settings", "workspace.delete",
    "workspace.export",
    "palette.jump",
    "inboxCard.archive", "inboxCard.dismiss", "inboxCard.snooze",
    "emptyState.openDeployPanel",
  ];
  check("134 keys named by §5 and §6", SPECIFIED.length === 134, `${SPECIFIED.length}`);
  const absent = SPECIFIED.filter((k) => !keys.includes(k));
  for (const k of absent) console.log(`  FAIL ${k} is in the specification and not in the manifest`);
  check("every specified key is in the registry", absent.length === 0);
}

console.log("\nthe three decisions that contradict the source document are the ones implemented");
{
  const mark = (key: string): string | undefined => entries.find((e) => e.key === key)?.export;
  // D2: an x closes a surface; cancel-01 aborts an operation. The document had them swapped on
  // these two, and put them six inches apart on the same board.
  check("D2 · inbox.dismiss is XIcon, not Cancel01Icon", mark("inbox.dismiss") === "XIcon");
  check("D2 · evals.cancel is Cancel01Icon, not XIcon", mark("evals.cancel") === "Cancel01Icon");
  check("D2 · the gate still aborts with Cancel01Icon", mark("cockpitGate.cancel") === "Cancel01Icon");
  // D4: the mark follows the object. A square-plus creates an agent; a bare plus creates a thread.
  check("D4 · agents.newThread is PlusIcon, not PlusSignSquareIcon",
    mark("agents.newThread") === "PlusIcon");
  check("D4 · agents.new keeps PlusSignSquareIcon", mark("agents.new") === "PlusSignSquareIcon");
  // D3: three refresh marks, each meaning something different.
  check("D3 · a list re-fetch is Refresh03Icon", mark("threads.refresh") === "Refresh03Icon");
  check("D3 · a failed operation retries with ReloadIcon", mark("cockpitWork.retry") === "ReloadIcon");
  check("D3 · an external sync is RefreshCwIcon", mark("github.syncMore") === "RefreshCwIcon");
  // D7: one key for all 21 palette rows.
  check("D7 · the palette has exactly one key",
    keys.filter((k) => k.startsWith("palette.")).length === 1);
  // I6: amber means running. `threadsFilter.running` is the one key that may sit near it, and it
  // is a filter chip rather than a live indicator — D5 requires it to be drawn STATIC, so nothing
  // may spin it. A `running` mark inside an `animate-spin` would be the chip claiming to be busy.
  const spun = [...bodies].filter(([, t]) =>
    /animate-spin[^\n]*Icon\.threadsFilter\.running|Icon\.threadsFilter\.running[^\n]*animate-spin/.test(t));
  check("D5 · the running chip is never animated", spun.length === 0,
    spun.map(([f]) => f).join(", "));
}

done();
