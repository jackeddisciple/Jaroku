// A STACK-TRACE FRAGMENT WHERE AN EMPTY STATE SHOULD BE.
//
// The Graph tab rendered the server's error string verbatim as its hint, under a title that says
// the state is not ready yet:
//
//   No graph for this version yet
//   ContractError: cannot import agents.working_agent.agent: No module named 'agents.working_agent'
//
// TWO CLAIMS AT ONCE, and they contradict each other. "Not yet" says wait; a hard import failure is
// not something waiting fixes. Between them is an internal Python module path, and after them is no
// suggested action at all — so §30's three questions ("what is empty, why, and what next") are
// answered one and a half times out of three, and the half is written for whoever wrote the server.
//
// THE STRING IS ACCURATE. That is worth saying, because the fix is not to hide it: `graph_cache` is
// null, the manifest is empty and there is no project on this replica, so the sentence is a true
// account of what happened. What it is not is a sentence addressed to the person reading it.
//
// SO THE CLASS IS MAPPED AND THE RAW STRING IS KEPT. A sentence for the failure, a next step where
// one genuinely exists, and the original error behind a disclosure — because the person debugging
// their own agent needs the module path, and the person who just opened a tab does not.
//
// UNRECOGNISED FAILURES KEEP THE RAW STRING AS THE HINT, deliberately. A default that swallowed an
// unknown error into "something went wrong" would be strictly worse than what this replaces: today
// the string is at least true. The mapping earns its place one class at a time.
//
//   npm run test:graph-error
/** What the Graph tab renders in place of a topology it could not draw. */
export interface GraphErrorCopy {
  /** Replaces the panel's title, so a failure never reads as "not ready yet". */
  title: string;
  /** One sentence saying what happened, addressed to the reader rather than to the server. */
  sentence: string;
  /** The next thing to do, or null when there is honestly nothing but retrying. */
  next: string | null;
  /** Whether re-asking the server is worth offering — false for a failure that will repeat. */
  retryable: boolean;
  /** The server's own string, kept for the disclosure. */
  raw: string;
}

/**
 * The failure classes this panel has copy for.
 *
 * ORDER MATTERS: an import failure whose message also names a path must read as an import failure,
 * because that is the more specific diagnosis and the one whose next step is different.
 */
const CLASSES: { id: string; match: RegExp; copy: Omit<GraphErrorCopy, "raw"> }[] = [
  {
    id: "import",
    match: /ModuleNotFoundError|ImportError|No module named|cannot import|ContractError/i,
    copy: {
      title: "This agent's code could not be loaded",
      sentence:
        "The graph is drawn by importing the project and inspecting the graph it builds, and that " +
        "import failed — so there is nothing to draw rather than nothing yet.",
      next: "Open the Code tab to see what this version actually contains.",
      retryable: true,
    },
  },
  {
    id: "missing_files",
    match: /could not read this agent's files|ENOENT|no such file|not found/i,
    copy: {
      title: "This agent's files are not on this machine",
      sentence:
        "A graph is introspected from the project on disk, and this replica does not have one for " +
        "this version.",
      next: "Restoring the version, or generating the agent again, is what puts the files back.",
      retryable: true,
    },
  },
  {
    id: "timeout",
    match: /timed out|timeout/i,
    copy: {
      title: "Introspecting this graph timed out",
      sentence: "The project took longer than the sandbox allows to import.",
      // A cold sandbox is genuinely slower than a warm one, so this is a retry that can succeed
      // rather than one offered because there was nothing else to say.
      next: null,
      retryable: true,
    },
  },
  {
    id: "empty",
    match: /no graph available/i,
    copy: {
      title: "No graph to show",
      sentence: "The server had nothing to say about this version's topology.",
      next: null,
      retryable: true,
    },
  },
];

/**
 * Copy for a graph failure, from the server's own error string.
 *
 * An empty or absent error still produces a definite answer, because the caller is already in the
 * failure branch: it got here because `graph.error` was set, and a formatter that returned nothing
 * would put a blank panel where the reason should be.
 */
export function graphErrorCopy(error: string | undefined | null): GraphErrorCopy {
  const raw = (error ?? "").trim();
  const found = raw ? CLASSES.find((c) => c.match.test(raw)) : undefined;
  if (found) return { ...found.copy, raw };
  return {
    title: "This graph could not be drawn",
    // THE RAW STRING IS THE SENTENCE for a class nothing recognises. It is true, which is more than
    // a generic apology would be, and the disclosure below it would otherwise repeat it.
    sentence: raw || "The server did not say why.",
    next: null,
    retryable: true,
    raw,
  };
}

/** Whether the mapping recognised this failure, for the panel's decision to disclose the raw text. */
export function isMappedGraphError(error: string | undefined | null): boolean {
  const raw = (error ?? "").trim();
  return Boolean(raw) && CLASSES.some((c) => c.match.test(raw));
}
