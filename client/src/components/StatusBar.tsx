import { useTraceStore } from "../store/traceStore.ts";
import { useDeployStore } from "../store/deployStore.ts";
import { isDeployInFlight } from "../types.ts";
import { backendHasFailed, useHostStore } from "../store/hostStore.ts";

const DOT: Record<string, string> = {
  open: "bg-ok",
  connecting: "bg-run",
  closed: "bg-err",
};
// ONE WORD ON SCREEN, THE SENTENCE ON HOVER. `disconnected — retrying…` is a sentence set in a
// code font in the app's chrome, and it was the widest thing in the strip at exactly the moment
// the product had least to say. The state is a colour and a word; what the product is doing about
// it is a detail, and a detail belongs in a tooltip.
const LABEL: Record<string, string> = {
  open: "connected",
  connecting: "connecting",
  closed: "disconnected",
};
/** The hover sentence when the shell has given up and did not say why. It always says why, so
 *  this is the fallback that should never render — named rather than inlined so a reader can tell
 *  it apart from the three below, which are about this tab rather than about the backend. */
const BACKEND_STOPPED = "Jaroku's backend is not running";
const DETAIL: Record<string, string> = {
  open: "Connected to the server",
  connecting: "Connecting to the server…",
  closed: "Disconnected — retrying",
};

/**
 * What is left at the foot of the window: whether this tab can talk to the server, and whether
 * anything is deploying.
 *
 * Both are facts about the session rather than about the thing on screen, which is why they are
 * down here. A run's own figures — its model, its steps, its tokens, its cost — are in its trace.
 */
export function StatusBar() {
  const connection = useTraceStore((s) => s.connection);
  const deploying = useDeployStore((s) => s.deployments.find((d) => isDeployInFlight(d.status)));
  const deployStage = useDeployStore((s) => (deploying ? (s.stage[deploying.id] ?? null) : null));
  const live = useDeployStore((s) => s.deployments.filter((d) => d.status === "live").length);
  // WHAT THE HOST KNOWS THAT THIS TAB DOES NOT. Null in a browser, and null under the desktop
  // shell too until something goes wrong. `disconnected — retrying` is the truth about what this
  // tab is doing and a lie about what is going to happen, and the difference between the two is
  // only visible from the process that started the backend.
  const backend = useHostStore((s) => s.status);
  const failed = backendHasFailed(backend);

  const sep = <span className="text-faint" aria-hidden>·</span>;

  /**
   * NOTHING TO SAY IS NO STRIP AT ALL.
   *
   * Hiding the connection indicator when it read "connected" left the ROW — 28px and a `border-t`
   * across the whole application, permanently, holding nothing. On a window with no title bar that
   * line is the last horizontal rule on screen, so the product read as content sitting on a second
   * plane with a seam under it: the exact "two layers" the shell's own inset had just been removed
   * for. An empty container is not neutral; it is a border and a gap.
   *
   * The three things this strip exists to say are all conditional, so the strip is too — and when
   * any of them becomes true it comes back with its border, its height and its place.
   */
  if (!failed && connection === "open" && !deploying && live === 0) return null;


  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-hair px-4 text-tiny text-muted">
      {/* The dot moves while it is connecting. Every other in-flight mark in this app pulses —
          the agent dot, the run glyph, the deploy chip — and this one indicator, the one that says
          whether any of the others can update at all, was static in all three states with only its
          colour changing. */}
      {/* SILENT WHEN THERE IS NOTHING WRONG. A dot and the word "connected", permanently lit in the
          corner of a working application, is a status light for the state that needs no light — it
          reports the absence of a problem, every second, for the life of the session. What it must
          never do is go quiet when something IS wrong, so `connecting`, `disconnected` and a
          backend the shell has given up on all still take the row: the strip appears when it has
          something to say. */}
      {(failed || connection !== "open") && (
      <span className="flex items-center gap-1.5" title={failed ? (backend?.message ?? BACKEND_STOPPED) : DETAIL[connection]}>
        <span
          className={`h-1.5 w-1.5 rounded-full ${failed ? "bg-err" : DOT[connection]} ${
            !failed && connection === "connecting" ? "animate-stream-pulse motion-reduce:animate-none" : ""
          }`}
        />
        {/* THE ONE WORD CHANGES WHEN RETRYING IS NOT WHAT IS HAPPENING. Everything about this
            strip's design — a colour and a word, the sentence on hover — is kept; what changes is
            that the word stops claiming a recovery that the shell has already given up on. */}
        <span className={`text-tiny ${failed ? "text-err" : "text-faint"}`}>
          {failed ? "backend stopped" : LABEL[connection]}
        </span>
      </span>
      )}

      {/* A deploy is the one thing that happens outside this machine, and it can be running
          while the user is reading something else entirely. It gets the far end of the strip. */}
      {deploying && (
        <>
          <span className="ml-auto shrink-0 text-run">deploying <span className="">{deploying.agent_id}</span></span>
          {sep}
          <span className="shrink-0 text-run">{deployStage ?? deploying.status}</span>
        </>
      )}
      {!deploying && live > 0 && (
        <span className="ml-auto shrink-0"><span className="tabular-nums">{live}</span> deployed</span>
      )}
    </div>
  );
}
