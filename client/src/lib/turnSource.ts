// What a turn IS, for the three things §5 and §6 need from every one of them: its markdown source,
// the metadata it reports, and the message that produced it.
//
// §5.1 IS THE REASON THIS FILE EXISTS RATHER THAN A `textContent` READ. "Copies the markdown
// source, not rendered text — people paste this into issues and docs." Reading the DOM would be
// three lines and would strip exactly the part being copied: the code fences, the paths, the
// structure. A plan pasted into a pull request as one paragraph of prose is a plan nobody can act
// on. It would also copy whatever happened to be expanded, so the same button would produce
// different text depending on which cards a reader had opened.
//
// SO EACH TURN KIND ANSWERS FOR ITSELF, from the store rather than from the screen.
//
// AND A TURN WITH NOTHING TO COPY RETURNS null RATHER THAN "". The action row is hidden entirely
// for those, which is honest — an enabled Copy that puts an empty string on the clipboard is worse
// than no Copy at all, because it looks like it worked.
//
//   npm run test:turn-source

import type { ChatTurn } from "../store/chatStore.ts";
import type { FileDiff } from "../types.ts";
import type { TurnMeta } from "./turnMetadata.ts";

/** The markdown a Copy should produce, or null when this turn has no response to copy. */
export function turnSource(turn: ChatTurn): string | null {
  if (turn.role === "user") return null;

  switch (turn.kind) {
    case "plan":
      // The RAW plan, which is already markdown as the model wrote it — not the parsed structure
      // re-serialised, which would be Jaroku's rendering of a plan rather than the plan itself.
      return turn.raw && turn.raw.trim() ? turn.raw : null;

    case "reply":
      return turn.text && turn.text.trim() ? turn.text : null;

    case "gen": {
      // A GENERATION'S `files` ARE PATHS HERE, not bodies — the contents live in buildStore, keyed
      // by path. That turns out to be the right answer rather than a limitation: "copy this
      // response" on a generation means what it built, and four Python files pasted into an issue
      // is not a message anybody meant to send. The Code view is where a body gets copied from.
      const files = turn.files ?? [];
      if (files.length === 0) return null;
      // A GenTurn carries no version number of its own — the version is published by the build
      // path and rendered by the Code view. What this turn knows is which files it wrote.
      const head = "Generated";
      return `${head}\n\n${files.map((path) => `- \`${path}\``).join("\n")}`;
    }

    case "proposal": {
      // The summary and the paths it touches. A unified diff would be the better paste, and the
      // client does not hold one — `FileDiff` carries the before/after the card renders rather
      // than a patch — so reconstructing one in the browser would be a second, worse
      // implementation of something the GitHub tab already does properly.
      const files = turn.files ?? [];
      const summary = turn.summary && turn.summary.trim() ? turn.summary : null;
      if (files.length === 0) return summary;
      const head = summary ? `${summary}\n\n` : "";
      return head + files.map((f) => `- \`${f.path}\``).join("\n");
    }

    default:
      return null;
  }
}

/**
 * What this turn reports about itself in the metadata row, or null when it has nothing to report.
 *
 * READ FROM THE TURN, NEVER FROM THE TOOLBAR — §6.2's rule, and the reason these fields ride on
 * the turn at all. The composer's current model and effort describe a request that has not
 * happened yet; this describes the one that did, and the two differ constantly because changing
 * the model is how somebody reacts to a response they did not like.
 *
 * A TURN WITH NO USAGE YET STILL GETS A ROW when it has a version to show, because §6.4's duration
 * counts up live beside a model that is known from the moment of dispatch. Returning null until
 * the numbers landed would make the whole row appear at the end of every response — a reflow
 * underneath the thing somebody is reading.
 */
export function metaForTurn(turn: ChatTurn): TurnMeta | null {
  if (turn.role === "user") return null;
  if (turn.kind === "info") return null;

  const usage = "usage" in turn ? turn.usage : null;
  const version = "version" in turn ? turn.version : undefined;

  // Nothing measured and nothing produced is a turn with nothing to say. An empty row of glyphs
  // under every reply would be chrome.
  if (!usage && version === undefined) return null;

  const diffFiles = turn.kind === "proposal" ? (turn.files ?? []) : [];
  const added = usage?.added ?? (diffFiles.length > 0 ? sumDiff(diffFiles, "additions") : null);
  const removed = usage?.removed ?? (diffFiles.length > 0 ? sumDiff(diffFiles, "deletions") : null);

  return {
    modelId: usage?.model ?? null,
    provider: usage?.provider ?? null,
    // Both levels. They are equal until something clamps, which reads as "nothing clamped" —
    // and that is true rather than a fallback.
    effortRequested: usage?.effort_requested ?? usage?.effort ?? null,
    effortApplied: usage?.effort ?? null,
    // §6.2: absent capability means no chip at all, never a meaningless "Low".
    effortSupported: Boolean(usage?.effort),
    versionLabel: version === undefined ? null : `v${version}`,
    // A proposal awaiting Apply is a version that is staged and not published — §6.3's amber
    // in-flight treatment. `pending` is the status chatStore gives exactly that state.
    versionStaged: turn.kind === "proposal" && turn.status === "pending",
    diffPlus: added,
    diffMinus: removed,
    durationMs: usage?.duration_ms ?? null,
    ordinal: usage?.variant_ordinal ?? 1,
    total: usage?.variant_total ?? 1,
  };
}

/** Line counts off the diff the card is already rendering, when the server did not send them. */
function sumDiff(files: readonly FileDiff[], key: "additions" | "deletions"): number {
  return files.reduce((n, f) => n + (f[key] ?? 0), 0);
}

/**
 * The message that produced this turn, so §5.4 can re-run it without anybody re-typing.
 *
 * A PLAN KEEPS ITS OWN PROMPT — "the brief this plan was written for", as chatStore puts it — and
 * that is the one to re-run rather than whatever is in the composer now, which may be a sentence
 * somebody started typing and abandoned. For the other kinds there is no stored prompt, so the
 * caller walks back to the preceding user turn; returning null here is what tells it to.
 */
export function turnPrompt(turn: ChatTurn): string | null {
  if (turn.role === "user") return turn.text || null;
  if (turn.kind === "plan") return turn.prompt || null;
  return null;
}

/**
 * The message a turn should be regenerated from, walking back through the thread when the turn
 * does not carry one itself.
 *
 * §5.4: "Re-runs the same user input with the current toolbar settings." The same INPUT — so a
 * generation three cards down the thread re-runs the sentence that started it, not the sentence
 * that happens to be in the box.
 */
export function promptForRegenerate(turns: readonly ChatTurn[], turn: ChatTurn): string | null {
  const own = turnPrompt(turn);
  if (own) return own;
  const at = turns.indexOf(turn);
  if (at < 0) return null;
  for (let i = at - 1; i >= 0; i--) {
    const prior = turns[i];
    if (prior && prior.role === "user" && prior.text.trim()) return prior.text;
  }
  return null;
}
