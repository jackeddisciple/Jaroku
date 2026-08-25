// What the expanded card shows: the evidence, in the words the payload already carries.
//
// §4.5: "the expanded state carries the evidence — a trace snippet, a diff stat, the last five lines
// of a build log". What is here is the honest version of that: everything the payload holds, which is
// names, ids, counts and short summaries and nothing else, because §6.5 puts nothing else in one.
//
// THE PAYLOAD IS THE ONLY SOURCE, and that is a deliberate limit rather than a first pass. A card
// that fetched a trace or a build log to fill itself in would be forty cards each opening a request
// on a board somebody is scrolling, and the fetch would be for the surface's own decoration. What a
// card can say without asking anybody is what it says; the actions are how somebody sees the rest.
//
// EACH TYPE RENDERS THE TWO OR THREE FIELDS ITS OWN KIND CARRIES, which is why this is a switch and
// not a generic key-value dump. `agent_uuid` on a screen is noise; `nine failed runs` is a sentence.
// A type with nothing more to say renders nothing at all rather than an empty region — the same
// empty-sections discipline the rest of the app follows.

import { Chip } from "./Chip.tsx";
import { DiffStat } from "./DiffStat.tsx";
import { Truncate } from "./Truncate.tsx";
import { relTime } from "../lib/format.ts";
import type { InboxItemView } from "../types.ts";

const str = (item: InboxItemView, key: string): string =>
  typeof item.payload[key] === "string" ? (item.payload[key] as string) : "";

const num = (item: InboxItemView, key: string): number | null =>
  typeof item.payload[key] === "number" ? (item.payload[key] as number) : null;

const list = (item: InboxItemView, key: string): string[] =>
  Array.isArray(item.payload[key]) ? (item.payload[key] as string[]).filter((v) => typeof v === "string") : [];

/** One line of evidence. Indented to the subject's column, so the icon gutter stays a gutter. */
function Line({ children }: { children: React.ReactNode }) {
  return <div className="ml-6 mt-1 text-tiny leading-[1.5] text-muted">{children}</div>;
}

export function InboxEvidence({ item }: { item: InboxItemView }) {
  switch (item.type) {
    case "credential_missing":
      return (
        <Line>
          {/* THE NAME, WHICH IS ALL THERE IS. §6.5 is explicit that a credential item carries the name
              of the missing credential, and there is no field on this payload a value could be in. */}
          <Chip size="sm" mono tone="faint">{str(item, "credential")}</Chip>
          <span className="ml-1.5">is declared by {str(item, "agent_slug") || "this agent"} and has no value behind it.</span>
        </Line>
      );

    case "deploy_failed": {
      const error = str(item, "error");
      return (
        <>
          {error && (
            <Line>
              {/* Already bounded and redacted on the way into the payload — see the server's
                  `boundPayload`. What reaches here has been through the same filter the log sinks use. */}
              <Truncate className="text-tiny text-muted" title={error}>{error}</Truncate>
            </Line>
          )}
          {str(item, "provider") && (
            <Line>
              <span className="text-faint">was building with </span>
              <Chip size="sm" mono tone="faint">{str(item, "model")}</Chip>
            </Line>
          )}
        </>
      );
    }

    case "version_drift": {
      const deployed = num(item, "deployed");
      const current = num(item, "current");
      if (deployed === null || current === null) return null;
      return (
        <Line>
          {/* READS LEFT TO RIGHT AS LIVE, THEN CURRENT, which is the order `agentHealth.driftOf`
              settled on — and the reason a deploy AHEAD of current draws no badge at all rather than
              the pair backwards. */}
          <Chip size="sm" mono tone="faint">v{deployed}</Chip>
          <span className="mx-1 text-faint">→</span>
          <Chip size="sm" mono tone="muted">v{current}</Chip>
          <span className="ml-1.5 text-faint">{current - deployed} version{current - deployed === 1 ? "" : "s"} behind</span>
        </Line>
      );
    }

    case "unreviewed_failures": {
      const runs = list(item, "run_ids");
      if (runs.length === 0) return null;
      return (
        <Line>
          {/* THE COUNT ON THE CARD IS THE HONEST TOTAL and this list is capped at twenty — see the
              server's `RUN_IDS_MAX`. Saying "the most recent" rather than "all" is what keeps the two
              from appearing to disagree. */}
          {runs.length === item.count
            ? `${runs.length} failed run${runs.length === 1 ? "" : "s"}, none of them opened.`
            : `The most recent ${runs.length} of ${item.count} failures. None opened.`}
        </Line>
      );
    }

    case "budget_ceiling_hit": {
      const ceiling = num(item, "ceiling_usd");
      return (
        <Line>
          {/* v0.1.9's DOCUMENTED LIMIT, said plainly rather than implied: a ceiling bounds what gets
              STARTED, never what is already running. Jobs in flight when it was crossed ran to
              completion, and a card claiming the eval was halted would teach a wrong model of a bill. */}
          Jobs already running finished; no new ones were started
          {ceiling !== null ? ` past $${ceiling.toFixed(2)}` : ""}.
        </Line>
      );
    }

    case "cost_anomaly": {
      const multiple = num(item, "multiple");
      if (multiple === null) return null;
      return (
        <Line>
          Spending <span className="text-ink">{multiple.toFixed(1)}×</span> its trailing seven-day average.
        </Line>
      );
    }

    case "ungated_high_impact": {
      const tools = list(item, "tools");
      if (tools.length === 0) return null;
      return (
        <>
          <Line>
            {tools.slice(0, 4).map((ref) => (
              <Chip key={ref} size="sm" mono tone="faint" className="mr-1">{ref}</Chip>
            ))}
            {tools.length > 4 && <span className="text-faint">+{tools.length - 4}</span>}
          </Line>
          {/* WHAT THIS DOES NOT CLAIM. v0.2.1 recorded that generated agent code can set the variable
              that disables the bridge's gate, and said a validation rule was needed. Surfacing the
              state is not that rule, so the sentence says what is true and stops there. */}
          <Line>
            <span className="text-faint">These can be called without stopping for a confirmation.</span>
          </Line>
        </>
      );
    }

    case "memory_proposal": {
      const instruction = str(item, "instruction");
      const version = num(item, "version");
      return (
        <>
          {instruction && (
            <Line>
              <Truncate className="text-tiny text-ink" title={instruction}>&ldquo;{instruction}&rdquo;</Truncate>
            </Line>
          )}
          <Line>
            {/* A MEMORY THAT CANNOT NAME THE EVIDENCE THAT PRODUCED IT MUST NOT EXIST (§2.3), so the
                card names all three legs: the failure, the fix, and the pass. `view evidence` opens
                them; this says what they were. */}
            <span className="text-faint">A run failed, </span>
            {version !== null && <Chip size="sm" mono tone="faint">v{version}</Chip>}
            <span className="text-faint"> fixed it, and later runs passed.</span>
          </Line>
        </>
      );
    }

    case "mcp_unreachable": {
      const lastSeen = str(item, "last_seen_at");
      if (!lastSeen) return null;
      return (
        <Line>
          <span className="text-faint">Last answered {relTime(lastSeen)}. Its tool list is untouched.</span>
        </Line>
      );
    }

    case "eval_finished":
    case "mcp_auth_required":
    case "invite_pending":
    case "member_joined":
    case "agent_deleted_by_other":
    case "setup_api_key":
    case "setup_first_agent":
      // NOTHING MORE TO SAY THAN THE SUBJECT LINE ALREADY SAID. An empty region under these would be
      // a box drawn around nothing, which the empty-sections discipline rules out everywhere else in
      // this app too.
      return null;
  }
}

/**
 * A diff stat, for the one place a card has one.
 *
 * EXPORTED AND UNUSED BY THE SWITCH ABOVE ON PURPOSE — §4.5 names a diff stat as one of the three
 * kinds of evidence, and `version_drift` is the item it belongs to, but the drift payload carries a
 * version PAIR rather than line counts and inventing them here would be a figure with nothing behind
 * it. This is the join for when the pair grows a stat, so the next person reaches for `DiffStat`
 * rather than hand-rolling one.
 */
export function EvidenceDiff({ additions, deletions }: { additions: number; deletions: number }) {
  return <DiffStat additions={additions} deletions={deletions} />;
}
