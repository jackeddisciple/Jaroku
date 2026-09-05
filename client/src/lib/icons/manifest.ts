// Registry key → HugeIcons export name. The one file anybody edits when an icon changes.
//
// THIS IS THE WHOLE MAPPING FROM ACTION TO MARK, and it is a table of strings on purpose. A call
// site asks for `Icon.agents.fork` because it is forking an agent; which glyph that draws is
// decided here and nowhere else. Changing what "fork" looks like is a one-line edit to this file,
// and a mark used in nine places cannot drift in eight of them — the failure this table exists to
// make impossible, and the one `test:icon-registry` fails on.
//
// STRINGS RATHER THAN IMPORTS, so this file is data and stays data. `scripts/gen-icons.mjs` reads
// these names to decide which of the package's 14,716 exports to write out as committed inline SVG,
// and `registry.ts` resolves them against the generated barrel. Neither direction can silently
// disagree: a name here that the installed package does not have fails the generator loudly rather
// than shipping a blank square, and a name the barrel cannot resolve fails typecheck.
//
// THE ORDER AND GROUPING MIRROR icons_integration §5 AND §6 EXACTLY, so a reader holding the
// specification can walk it top to bottom against this file. Where a key's mark departs from what
// that document printed, the reason is on the line — those are §4's decisions, and there are three.

export const MANIFEST = {
  // ── §5 Sidebar rail ───────────────────────────────────────────────────────
  nav: {
    threads: "AddressBookIcon",
    agents: "Robot02Icon",
    cockpit: "GameController03Icon",
    inbox: "InboxIcon",
    activity: "RadioTowerIcon",
    providerKeys: "KeySquareIcon",
  },

  // ── §5 Sidebar panel + §6 Workspace panel ─────────────────────────────────
  //
  // The switcher's two marks are one control in two states, and the pair is the reason the
  // `IconButton` contract says a toggle's label names the ACTION rather than the state: the
  // closed chevron's button is "Open the workspace switcher", not "closed".
  workspace: {
    switcherClosed: "ArrowDown01Icon",
    switcherOpen: "ArrowUp01Icon",
    close: "XIcon",
    removeMember: "UserMinus02Icon",
    revokeInvite: "UserXIcon",
    invite: "UserPlusIcon",
    // D4: the mark follows the OBJECT, not the surface. A square-plus creates an agent; a bare
    // plus creates everything else, a workspace included.
    newWorkspace: "PlusIcon",
    settings: "Settings02Icon",
    delete: "Delete02Icon",
    export: "Upload04Icon",
  },

  // ── §5 Agents ─────────────────────────────────────────────────────────────
  agents: {
    search: "Search01Icon",
    filter: "FilterIcon",
    // Shared with the sidebar's "new agent" deliberately — one action, one mark, two surfaces.
    new: "PlusSignSquareIcon",
    // D3: `Refresh03Icon` is "re-fetch the list I am looking at". See the note on `github.syncMore`.
    refresh: "Refresh03Icon",
    filterGrid: "SlidersHorizontalIcon",
    viewGrid: "Grid3X2Icon",
    viewTable: "TableOfContentsIcon",
    searchGrid: "Search01Icon",
    // D4, AND THIS CONTRADICTS THE SOURCE DOCUMENT, which printed `plus-sign-square` here. The
    // object being created is a THREAD, not an agent, so it takes the bare plus that every other
    // "new thread" in the product takes. The document's version put two different marks on one
    // verb a user meets twice in a session.
    newThread: "PlusIcon",
    fork: "GitForkIcon",
    more: "MoreHorizontalIcon",
    restore: "RestoreBinIcon",
  },

  // ── §5/§6 Auth and onboarding ─────────────────────────────────────────────
  auth: {
    signOut: "Logout01Icon",
    signIn: "Login01Icon",
    openJaroku: "ArrowUpRight01Icon",
  },

  // ── §5 Right panel rail ───────────────────────────────────────────────────
  //
  // TEN MARKS IN ONE VERTICAL STRIP, which is the single place in this product where an optical
  // weight mismatch is most visible — it is why §11 asks for this rail by name. Every one of them
  // is drawn through the same factory at the same token, `GameController03Icon` included, which
  // ships from the package at stroke 2 and would otherwise sit heavier than its nine neighbours.
  panel: {
    agent: "Orbit02Icon",
    graph: "ArtboardIcon",
    trace: "FootprintsIcon",
    evals: "FileValidationIcon",
    mcp: "McpServerIcon",
    connections: "CableIcon",
    deploy: "Rocket01Icon",
    secrets: "KeyGeneratorFobIcon",
    github: "GithubIcon",
    usage: "LimitationIcon",
  },

  // ── §5 Threads ────────────────────────────────────────────────────────────
  threads: {
    refresh: "Refresh03Icon",
    new: "PlusIcon",
    archive: "Archive04Icon",
    restore: "RestoreBinIcon",
  },

  // ── §5/§6 Agent detail ────────────────────────────────────────────────────
  agentDetail: {
    rename: "PencilEdit01Icon",
    export: "Upload01Icon",
    copy: "CopyIcon",
    publishVersion: "BookUploadIcon",
    restoreVersion: "CloudSyncIcon",
    grantTool: "ToolboxIcon",
  },

  // ── §5 Cockpit ────────────────────────────────────────────────────────────
  cockpit: {
    refresh: "Refresh03Icon",
    openConversation: "MessageSquareDashedIcon",
    agentMore: "MoreIcon",
    // D2: an X closes a SURFACE. This one shuts the work detail.
    closeDetail: "XIcon",
    copyJobId: "CopyIcon",
  },

  // ── §5/§6 Composer ────────────────────────────────────────────────────────
  //
  // The last four keys are D8's — the composer's control bar, its ⊕ menu and the turn rows below
  // it used to draw through `@hugeicons/react` at their own stroke weight. Folding them in here is
  // what let that dependency come out; see the note at the top of `registry.ts`.
  composer: {
    attach: "AttachmentIcon",
    expand: "FullScreenIcon",
    more: "MoreVerticalIcon",
    mic: "Mic01Icon",
    send: "SendIcon",
    addKey: "KeyRoundIcon",
    effort: "AiBrain02Icon",
    permissions: "ShieldEnergyIcon",
    connectors: "ConnectIcon",
  },

  // ── D8 · the composer's ⊕ menu, five sources ──────────────────────────────
  attach: {
    file: "FileAddIcon",
    run: "RepairIcon",
    dataset: "DatabaseImportIcon",
    tool: "FlowConnectionIcon",
    github: "GithubIcon",
  },

  // ── D8 · the message action row under an assistant turn ───────────────────
  turn: {
    copy: "CopyIcon",
    note: "Note02Icon",
    pin: "PinIcon",
    // D3: `ReloadIcon` is "retry an operation that failed" — and regenerating a turn is retrying
    // the generation, which is why it shares a mark with `cockpitWork.retry` and `graph.retry`.
    regenerate: "ReloadIcon",
    thumbUp: "ThumbsUpIcon",
    thumbDown: "ThumbsDownIcon",
  },

  // ── D8 · the response metadata row ────────────────────────────────────────
  meta: {
    build: "BracesIcon",
    duration: "HourglassIcon",
  },

  // ── §5/§6 Inbox ───────────────────────────────────────────────────────────
  inbox: {
    refresh: "Refresh03Icon",
    laneInbox: "InboxIcon",
    laneAlerts: "Alert01Icon",
    lanePermissions: "CircleLockAdd02Icon",
    laneProposals: "LightbulbIcon",
    laneSnoozed: "AlarmClockMinusIcon",
    // D2, AND THIS CONTRADICTS THE SOURCE DOCUMENT, which printed `cancel-01`. Dismissing is
    // closing a surface, not aborting an operation, and the document put `cancel-01` on a lane
    // six inches from an `x` doing the identical job on a card. Both are `XIcon` now.
    dismiss: "XIcon",
    undo: "Undo03Icon",
  },
  inboxCard: {
    archive: "ArchiveArrowDownIcon",
    // D2, same correction, and this is the half the document already had right.
    dismiss: "XIcon",
    snooze: "NotificationSnooze01Icon",
  },

  // ── §5 Activity ───────────────────────────────────────────────────────────
  activity: {
    dateRange: "CalendarRangeIcon",
    filterKind: "ListFilterIcon",
  },

  // ── §5 Usage ──────────────────────────────────────────────────────────────
  usage: { exportCsv: "FileExportIcon" },

  // ── §5/§6 Connections ─────────────────────────────────────────────────────
  connections: {
    disconnect: "UnplugIcon",
    save: "SaveIcon",
  },

  // ── §5 Secrets ────────────────────────────────────────────────────────────
  secrets: {
    reveal: "EyeIcon",
    copy: "CopyIcon",
  },

  // ── §5/§6 GitHub ──────────────────────────────────────────────────────────
  github: {
    // D3, and the reason there are three refresh marks rather than one. `RefreshCwIcon` means
    // "sync with an EXTERNAL system" — two arrows chasing each other, which is what a two-way
    // sync is — and GitHub is the only external system this product syncs with. `Refresh03Icon`
    // re-fetches a local list; `ReloadIcon` retries a failed operation.
    syncMore: "RefreshCwIcon",
    openPullRequest: "GitPullRequestIcon",
    connect: "GithubIcon",
  },

  // ── §5/§6 Deploy ──────────────────────────────────────────────────────────
  deploy: {
    // Not `Cancel01Icon`. A deploy in flight is aborted from a circular control that reads as a
    // stop rather than as a dismissal, and the document is right about this one.
    cancel: "CancelCircleIcon",
    buildLog: "ScrollTextIcon",
    connectRailway: "SpeedTrain01Icon",
    deployAnother: "CopyPlusIcon",
  },

  // ── §5/§6 Evals ───────────────────────────────────────────────────────────
  evals: {
    addExample: "AddCircleIcon",
    importCsv: "FileImportIcon",
    deleteDataset: "Delete01Icon",
    renameDataset: "PencilEdit01Icon",
    editRubric: "Edit01Icon",
    revertRubric: "Undo02Icon",
    // D2: closing the comparison surface, so an X.
    clearComparison: "XIcon",
    prevResponse: "ChevronLeftIcon",
    nextResponse: "ChevronRightIcon",
    run: "PlayIcon",
    // D2, AND THIS CONTRADICTS THE SOURCE DOCUMENT, which printed `x`. Cancelling an eval aborts
    // an IN-FLIGHT OPERATION rather than closing a surface, which is exactly the half of the split
    // `Cancel01Icon` owns.
    cancel: "Cancel01Icon",
  },

  // ── §5 Trace ──────────────────────────────────────────────────────────────
  trace: {
    pause: "PauseIcon",
    resume: "PlayIcon",
    stop: "StopIcon",
  },

  // ── §5 Global ─────────────────────────────────────────────────────────────
  global: {
    clearSearch: "SearchXIcon",
    clearFilter: "ListXIcon",
    dismissNotice: "XIcon",
  },

  // ── §6 Top bar ────────────────────────────────────────────────────────────
  topbar: {
    deploy: "Rocket01Icon",
    dryRun: "SquareTerminalIcon",
  },

  // ── §6 Threads filter ─────────────────────────────────────────────────────
  threadsFilter: {
    all: "Layers01Icon",
    needsYou: "UserRoundCogIcon",
    // D5: rendered STATIC, never spun. It is a chip that names a filter, not an indicator that
    // something is loading — and the amber running dot already on those rows is the live signal.
    running: "LoaderCircleIcon",
    recent: "Clock02Icon",
    archived: "Archive04Icon",
  },

  // ── §6 Cockpit filter ─────────────────────────────────────────────────────
  //
  // `all` is `Layers01Icon` here and in the Threads filter above, and that is intentional rather
  // than a copy-paste: one word, one mark, two rows that a reader sees side by side. §11 asks for
  // exactly that pair to be looked at together.
  cockpitFilter: {
    mine: "UserRoundIcon",
    everyones: "UsersRoundIcon",
    all: "Layers01Icon",
    showEverything: "ListIcon",
    showEveryAgent: "NetworkIcon",
  },

  // ── §6 Cockpit work detail ────────────────────────────────────────────────
  cockpitWork: {
    openTrace: "SquareArrowOutUpRightIcon",
    // D3: retrying an operation that failed.
    retry: "ReloadIcon",
    stop: "StopIcon",
  },

  // ── §6 Cockpit gate ───────────────────────────────────────────────────────
  cockpitGate: {
    dispatch: "ArrowBigRightDashIcon",
    // D2: a gate is an operation being aborted, not a surface being closed.
    cancel: "Cancel01Icon",
  },

  // ── §6 Fleet card menu ────────────────────────────────────────────────────
  fleet: {
    logs: "ScrollTextIcon",
    reconnect: "PlugIcon",
    // Destructive. Takes the design system's destructive treatment, never amber — amber means
    // running, and killing something that is running must not be drawn in the colour of running.
    kill: "SkullIcon",
  },

  // ── §6 MCP ────────────────────────────────────────────────────────────────
  mcp: { connectServer: "McpServerIcon" },

  // ── §6 Graph ──────────────────────────────────────────────────────────────
  graph: { retry: "ReloadIcon" },

  // ── §6 Workspace panel tabs ───────────────────────────────────────────────
  //
  // D6: ALL SIX GET ICON + LABEL. The document marked four of them icon-only and left `members`
  // and `billing` labelled, which reads as an unfinished strip. These are settings destinations
  // opened twice a month — precisely where a bare icon fails, because nobody builds muscle memory
  // for a screen they rarely visit.
  workspaceTab: {
    general: "Settings04Icon",
    members: "UsersRoundIcon",
    audit: "ClipboardListIcon",
    billing: "CreditCardIcon",
    data: "DatabaseIcon",
    account: "UserRoundIcon",
  },

  // ── §6 Command palette ────────────────────────────────────────────────────
  //
  // D7: ONE KEY, NOT 21. All 21 rows carry the same trailing "this navigates" affordance, which
  // is a property of the row component rather than of any verb in it. A leading mark that says
  // WHAT each row opens would be a different piece of work with its own reasoning.
  palette: { jump: "ArrowUpRight01Icon" },

  // ── §6 Empty state actions ────────────────────────────────────────────────
  emptyState: { openDeployPanel: "ArrowUpRight01Icon" },
} as const;

/** Every surface group in the registry. */
export type IconGroup = keyof typeof MANIFEST;

/** Every distinct HugeIcons export the manifest names — the generator's exact work list. */
export const EXPORT_NAMES: readonly string[] = [
  ...new Set(Object.values(MANIFEST).flatMap((group) => Object.values(group) as string[])),
].sort();
