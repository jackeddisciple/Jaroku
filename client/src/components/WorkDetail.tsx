// §7's detail: what was asked, what came back, what went wrong, what it cost, and a link to the trace.
//
// A PANEL, NOT A MODAL, AND THE DIFFERENCE IS THE WHOLE DESIGN. §3D: "The list stays interactive
// behind it. No scrim, no focus trap — this is a panel, not a modal, and the difference matters: a
// modal says DEAL WITH THIS NOW, and a work item's detail never does." An operator scanning forty
// rows opens one, reads it, and goes back to scanning; a dialog would make each of those a
// transaction.
//
// AND IT DOES NOT BUILD A SECOND TRACE VIEWER — §7 and §15 both. The link goes down the ORDINARY
// `loadRun` path, which is the one route into a trace from any surface in this product and is also
// what stamps a failure as reviewed for the Inbox. "Do not render steps here — a second trace
// viewer is how two trace viewers start to disagree." A panel that rendered steps would be a second
// timeline, a second step-detail, and a second thing to keep in step with the frozen schema — and
// the Inbox card the failure raised would never resolve, because nothing would have been opened.
//
// REACHABLE BY ID ALONE, which is Part 2's §12 constraint honoured now rather than later: "the work
// detail must be reachable by id alone, because a citation chip opens it without a list in
// between". `sendLoadWorkItem` takes an id and needs no page.
//
// §12's FOCUS CONTRACT, WHICH IS THREE THINGS AND NOT ONE. It is a labelled complementary region;
// it does NOT trap focus; and "Escape closes it and RETURNS FOCUS TO THE ROW THAT OPENED IT". The
// third is the one that gets left out, and leaving it out is what strands a keyboard user at the
// top of the document after every close.

import { useEffect, useRef, useState } from "react";

import { DETAIL, FAILURE_SENTENCE, GATE, REFUSAL, STATUS_WORD } from "../lib/cockpitCopy.ts";
import { cockpitAbsolute, cockpitCost, cockpitDuration, cockpitTokens } from "../lib/cockpitFormat.ts";
import { selectRun } from "../lib/selection.ts";
import { sendCancelWork, sendLoadRun, sendRetryWork } from "../lib/socket.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { useCanRun } from "../lib/useCapability.ts";
import { workLink } from "../lib/workLink.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useWorkStore } from "../store/workStore.ts";
import type { WorkItemDetailView } from "../types.ts";
import { Chip } from "./Chip.tsx";
import { CollapsibleRegion } from "./CollapsibleRegion.tsx";
import { DisabledReason, ENABLED, type DisabledState } from "./DisabledReason.tsx";
import { LoadingLine } from "./EmptyState.tsx";
import { WorkGlyph } from "./WorkGlyph.tsx";
import { Truncate } from "./Truncate.tsx";
import { XIcon } from "./panelIcons.tsx";

/**
 * How many lines of somebody's own text are shown before it folds.
 *
 * A STATED LINE COUNT, which §7 asks for by name: "In a `CollapsibleRegion` when it is long,
 * collapsed by default past a stated line count." Twelve is about a screenful of the panel at
 * `caption`'s line height — enough that a short input, which is most of them, never folds at all,
 * and few enough that a pasted customer email does not push the figures below it out of view.
 *
 * THE FIGURES ARE WHY THERE IS A LIMIT AT ALL. Somebody opening this panel on a failed job is
 * looking for the cost and the failure sentence; a 400-line input between the header and those is
 * a panel whose answer is off-screen.
 */
const FOLD_ABOVE_LINES = 12;

/**
 * Whether a block of text should be set in the mono face.
 *
 * §7: "in the app's monospace treatment IF IT LOOKS LIKE STRUCTURED TEXT and prose otherwise."
 *
 * THE TEST IS "WOULD FIXED-WIDTH COLUMNS MATERIALLY HELP SOMEBODY PARSE IT", not "does it look
 * technical" — `typeScale.ts` spends a paragraph on that distinction and names the failure: a slug,
 * a version, a timestamp and a model name all LOOK like code and none of them is, and setting them
 * in Mono is what made two thirds of this client's text monospaced. An agent's input is usually a
 * sentence somebody typed; when it is a JSON document, the columns genuinely help.
 *
 * SO THE TEST IS STRUCTURAL AND CONSERVATIVE: it has to parse. A string that merely starts with a
 * brace is not evidence of anything, and prose set in mono reads as a log line — which is a worse
 * error than JSON set in prose, because the second is merely plain and the first is misleading.
 */
function looksStructured(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * The dispatcher's truncation marker, split off so it can be said in `text-faint`.
 *
 * §7: "When it was truncated by the dispatcher, SAY SO WHERE THE TEXT ENDS, in `text-faint` — a
 * truncation the reader cannot see is a lie by omission, and Part 2 already requires the cap to be
 * announced in the stored value rather than silent."
 *
 * SO THE ANNOUNCEMENT IS ALREADY IN THE STRING and this does not invent it: `payload.ts` appends
 * `… truncated — N bytes were stored down to M` at the boundary, deliberately inside the cap so the
 * sentence itself is never cut. What is added here is that it is set apart from the agent's own
 * words, because a reader skimming to the end of an answer must not read the product's sentence as
 * the agent's.
 */
function splitTruncation(text: string): { body: string; notice: string | null } {
  const at = text.lastIndexOf("\n… truncated — ");
  if (at < 0) return { body: text, notice: null };
  return { body: text.slice(0, at), notice: text.slice(at + 1) };
}

/**
 * A block of somebody's own text — the input, or what the agent said back.
 *
 * PRE-WRAPPED, because both are arbitrary length and neither is markup: an input is a real customer
 * email and an output is what the agent did about it. Rendering either as flowing prose would
 * collapse the line breaks that make a pasted email readable.
 *
 * SELECTABLE, which §7 asks for and which is the default — it is worth stating only because the
 * temptation on a dense panel is `select-none`, and the whole reason somebody opens this block is
 * to copy what is in it into a bug report.
 */
function TextBlock({ label, text }: { label: string; text: string }) {
  const { body, notice } = splitTruncation(text);
  const lines = body.split("\n").length;
  const long = lines > FOLD_ABOVE_LINES;
  // COLLAPSED BY DEFAULT ONLY WHEN IT IS LONG. A short input that opened folded would be one press
  // between the reader and the thing they came for, on the majority of jobs.
  const [open, setOpen] = useState(!long);

  const block = (
    <div className="max-h-[40vh] overflow-auto rounded-control border border-hair bg-canvas px-2.5 py-2">
      <pre
        className={`whitespace-pre-wrap break-words text-caption leading-[1.55] text-ink ${
          looksStructured(body) ? "font-mono" : "font-sans"
        }`}
      >
        {body}
      </pre>
      {/* WHERE THE TEXT ENDS, in `text-faint`, and never inside the `pre` — a reader copying the
          answer out must not carry the product's sentence about it into their bug report. */}
      {notice && <p className="mt-1.5 text-tiny text-faint">{notice}</p>}
    </div>
  );

  // `CollapsibleRegion` OWNS THE HEADER when the block folds, so the label, the count and the
  // chevron are the same shape the GitHub panel's four regions use. A short block keeps the plain
  // section label rather than growing a chevron that would never be pressed.
  if (!long) {
    return (
      <div className="flex min-h-0 flex-col gap-1">
        <span className={TYPE.sectionLabel}>{label}</span>
        {block}
      </div>
    );
  }
  return (
    <CollapsibleRegion label={label} count={lines} open={open} onToggle={() => setOpen((v) => !v)}>
      {block}
    </CollapsibleRegion>
  );
}

/**
 * §7's metadata line: one line, wrapping rather than truncating.
 *
 * "This is a REFERENCE BLOCK; the reader is here on purpose." Which is the argument for both of its
 * two properties: it is `caption`/`text-muted` because it is not what the panel is about, and it
 * WRAPS because every fact in it is one somebody came to check — a truncated model name is the one
 * that is useless, since the interesting part of `claude-haiku-4-5-20251001` is the end.
 *
 * THE DEPLOYMENT FACTS COME FROM THE FLEET CARD, which is where they live: a work item records
 * which deployment ran it, and the deployment's version, provider and model are the strip's. An
 * agent that has since been killed has no card, and those three are then ABSENT rather than
 * guessed — the same rule the pre-flight gate follows, for the same reason.
 */
function MetadataLine({ item }: { item: WorkItemDetailView }) {
  const card = useWorkStore((s) => s.fleet.find((c) => c.deployment_id === item.deployment_id));
  const started = cockpitAbsolute(item.started_at ?? item.created_at);
  const took = cockpitDuration(item.duration_ms);

  const facts: { label: string; value: string; title?: string }[] = [
    ...(card
      ? [
          // NULL IS NOT ZERO AND NOT "v1": a deployment written before migration 041 has no record
          // of which version it ran, and guessing one would be a confident lie about production.
          { label: "version", value: card.version === null ? GATE.unrecordedVersion : `v${card.version}` },
          { label: "provider", value: card.provider },
          { label: "model", value: card.model },
        ]
      : []),
    { label: "asked by", value: item.created_by_name ?? "somebody who has left" },
    { label: "started", value: started.text },
    { label: "took", value: took.text, title: took.title ?? undefined },
  ];

  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-caption leading-[1.5] text-muted">
      {facts.map((fact, i) => (
        <span key={fact.label} title={fact.title}>
          {i > 0 && <span className="text-faint">· </span>}
          <span className="text-faint">{fact.label} </span>
          <span className="text-ink">{fact.value}</span>
        </span>
      ))}
    </p>
  );
}

/** One figure of §7's fourth block. `tabular-nums`, and an em dash that carries its reason. */
function Figure({ label, figure }: { label: string; figure: { text: string; title: string | null; floor: boolean } }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-caption">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="tabular-nums text-ink" title={figure.title ?? undefined}>
        {figure.text}
        {/* §17: WHEN PRICING IS PARTIAL, THE COST CARRIES THE APP'S EXISTING INCOMPLETE MARKER
            RATHER THAN A FOOTNOTE OF ITS OWN. The `+` is that marker; the sentence explaining it is
            on the hover, which is where the row's `+` sends the reader too. */}
        {figure.floor && <span className="text-faint">+</span>}
      </span>
    </div>
  );
}

export function WorkDetail() {
  const item = useWorkStore((s) => s.open);
  const openingId = useWorkStore((s) => s.openingId);
  const close = useWorkStore((s) => s.closeItem);
  const needsLoad = useTraceStore((s) => s.needsLoad);
  const setRightTab = useUiStore((s) => s.setRightTab);
  // §20s link carries the workspace, because a work item is scoped and a link naming only the item
  // would be unopenable by the person who receives it.
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const open = Boolean(item ?? openingId);

  /**
   * §12: "Escape closes it and RETURNS FOCUS TO THE ROW THAT OPENED IT."
   *
   * THE OPENER IS REMEMBERED WHEN THE PANEL OPENS AND NOT WHEN IT CLOSES, which is the whole trick:
   * by the time Escape is pressed, focus may be anywhere — inside the panel, on the close button,
   * or nowhere at all if the reader clicked the scrim of some other overlay. `document.activeElement`
   * at the moment of opening is the only reading of "the row that opened it" that is true.
   *
   * AND IT IS CHECKED FOR STILL BEING ON THE PAGE. The list is virtualised (§18), so a row scrolled
   * far out of the window is genuinely no longer in the DOM — focusing a detached element throws in
   * no browser but does nothing in all of them, which would strand the keyboard at the document
   * root. When the opener is gone the panel gives focus back to the list itself, which is where the
   * reader was.
   */
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) opener.current = (document.activeElement as HTMLElement | null) ?? null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      close();
      const back = opener.current;
      if (back && document.contains(back)) back.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const closeAndReturn = (): void => {
    close();
    const back = opener.current;
    if (back && document.contains(back)) back.focus({ preventScroll: true });
  };

  const live = item && (item.status === "queued" || item.status === "running" || item.status === "waiting");
  /**
   * §14: A CONTROL THE READER LACKS PERMISSION FOR IS DISABLED WITH A STATED REASON, NOT MISSING.
   *
   * WHICH OVERRULES §7's "gated by `Capable`", and the two sections genuinely disagree — §7 names
   * the component and §14 spends a paragraph on the behaviour, so §14 wins on the point it is
   * about. The reasoning is specific to a console: `Capable` renders nothing, on Part 2's argument
   * that an absent control cannot be found in devtools and clicked; §14 answers that for THIS tab,
   * because an operator who cannot see that Stop exists concludes the product cannot stop a job,
   * which is a worse belief to leave somebody with than "you cannot do this here".
   *
   * THE REASON NAMES THE CAPABILITY IN HUMAN WORDS — §14 again — which is what `REFUSAL` holds.
   */
  const canCancel = useCanRun("cancelWork", item?.agent_id ?? null);
  const canRetry = useCanRun("retryWork", item?.agent_id ?? null);
  const cancelState: DisabledState = canCancel ? ENABLED : { reason: REFUSAL.cancel };
  const retryState: DisabledState = canRetry ? ENABLED : { reason: REFUSAL.retry };

  /**
   * The trace, down the ordinary path.
   *
   * IT LEAVES THE COCKPIT, and that is deliberate rather than a shortcut: a trace is the three-pane
   * application's own surface, with the timeline, the step detail, the graph and the state diff
   * around it. `selectRun` RATHER THAN THREE STORE WRITES — it closes the full-screen view, clears
   * the nav section, selects the run AND follows it to the agent that made it, which is the dance
   * every other surface that opens a trace already does. Writing it out here would be a fifth copy,
   * and the one that forgets the agent leaves the header naming somebody else's work.
   */
  const openTrace = (): void => {
    if (!item?.run_id) return;
    if (needsLoad(item.run_id)) sendLoadRun(item.run_id);
    selectRun(item.run_id);
    setRightTab("trace");
  };

  return (
    // §3D, and every value in this class list is one of its clauses.
    //
    // `z-30` IS `LAYER.menu`, the popover rung §3D names. `bg-elevated` AND `border-l border-edge`
    // AND `shadow-floating` TOGETHER, never the shadow alone: `tokens.ts` states that rule and §3D
    // restates it, and it is "the difference between 'floating' and 'a drawn rectangle'".
    //
    // `max-w-[92%]` IS §13'S NARROW BEHAVIOUR and `w-[420px]` is §3D's "comfortable reading measure,
    // capped so that on a wide monitor it does not become a second page". At the narrowest supported
    // width the cap wins and the panel is effectively full-width over the list, which is what §13
    // asks for in place of "a slide-over at a fraction of a narrow column".
    //
    // NO SCRIM AND NO FOCUS TRAP — §3D and §12 both. `duration-base` BOTH WAYS, because §11 requires
    // the close to take as long as the open: "an asymmetric close reads as a glitch."
    <div
      className={`absolute top-0 right-0 bottom-0 z-30 flex w-[420px] max-w-[92%] flex-col border-l border-edge bg-elevated shadow-floating transition-transform duration-base ease-state ${
        open ? "translate-x-0" : "pointer-events-none translate-x-full"
      }`}
      aria-hidden={!open}
      role="complementary"
      aria-label={DETAIL.label}
    >
      {/* §7's HEADER: the agent's name, the status glyph, and a close control. The NAME rather than
          the word "Job", because the panel is about a job somebody already chose and what they are
          checking is which agent ran it. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-hair px-4 py-3">
        {item && <WorkGlyph status={item.status} />}
        <Truncate className={`min-w-0 flex-1 ${TYPE.title}`} title={item?.agent_name ?? undefined}>
          {item?.agent_name ?? DETAIL.label}
        </Truncate>
        <button
          type="button"
          onClick={closeAndReturn}
          className="shrink-0 rounded-control p-0.5 text-muted transition-colors duration-fast hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          title={`${DETAIL.close} (Esc)`}
          aria-label={DETAIL.close}
        >
          <XIcon size={ICON.sm} />
        </button>
      </div>

      {!item ? (
        // §10: THE DETAIL PANEL GETS `LoadingLine`, not a skeleton. It opens on an id rather than on
        // a shape, so there is nothing whose geometry a skeleton could match — and the panel is
        // never a blank slide-over, because the line says what is happening.
        //
        // AND ONLY WHILE IT IS OPEN. This panel is MOUNTED ALWAYS and translated off-screen so the
        // slide plays in both directions, which meant a closed Cockpit still held a turning arc:
        // `!item` is true whenever nothing is open, so the loader animated for the whole life of
        // the session, off screen, forever. §15's "no auto-refresh spinner" is about a spinner
        // nobody asked for, and this was one that nobody could even see.
        open && <LoadingLine label="Reading the job…" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-3 pb-5">
          <MetadataLine item={item} />

          {/* 1. WHAT WAS ASKED. */}
          <TextBlock label={DETAIL.asked} text={item.input} />

          {/* 2. WHAT CAME BACK, on a job that produced something. `!= null` rather than `!== null`,
                 which is the difference between a job that produced nothing and one that has not
                 produced anything YET: a running job's `output` is absent, and rendering "(the
                 agent produced nothing)" over it is a claim about an answer not yet given. */}
          {item.output != null && (
            <TextBlock label={DETAIL.cameBack} text={item.output || `(${DETAIL.emptyOutput})`} />
          )}

          {/* 3. WHAT WENT WRONG, when it did. §7: the `failure_kind` as a short heading and the
                 message beneath it, and each kind gets ITS OWN SENTENCE — written out, not a mapped
                 enum label. The sentences live in `cockpitCopy` so the six can be read as prose in
                 one diff; two of them are quoted verbatim by three documents.

                 ROSE IS SCARCE. The sentence is ink on the ordinary ladder and the failure is
                 carried by the glyph in the header; a red block here would be the second place in
                 the product that paints a whole region for a failure. */}
          {(item.failure_kind || item.error) && (
            <div className="flex flex-col gap-1">
              <span className={TYPE.sectionLabel}>{DETAIL.wentWrong}</span>
              {item.failure_kind && (
                <p className="text-caption leading-[1.55] text-ink">{FAILURE_SENTENCE[item.failure_kind]}</p>
              )}
              {/* AND THE AGENT'S OWN MESSAGE UNDER IT, which is a different fact from the kind: the
                  kind is Jaroku's classification and this is what the container said. A stack trace
                  goes here, which is why it is a scrolling block rather than a paragraph. */}
              {item.error && (
                <pre className="max-h-[24vh] overflow-auto whitespace-pre-wrap break-words rounded-control border border-hair bg-canvas px-2.5 py-2 font-mono text-tiny leading-[1.5] text-muted">
                  {item.error}
                </pre>
              )}
            </div>
          )}

          {/* 4. THE FIGURES. Every one goes through `cockpitFormat`, so the panel, the row and the
                 card cannot disagree — and every em dash carries the reason it is one. */}
          <div className="flex flex-col gap-0.5">
            <span className={TYPE.sectionLabel}>Figures</span>
            <Figure label="Cost" figure={cockpitCost(item.cost_usd, item.cost_complete)} />
            <Figure label="Tokens" figure={cockpitTokens(item.tokens)} />
            <Figure label="Duration" figure={cockpitDuration(item.duration_ms)} />
          </div>

          <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
            {/* 5. THE TRACE LINK — one control, through `loadRun` and nowhere else. Absent rather
                   than disabled for a job that never reached a container: there is no trace, and a
                   control that explained itself would be an offer being refused. */}
            {item.run_id && (
              <button
                type="button"
                onClick={openTrace}
                className="rounded-control border border-hair px-2.5 py-1 text-tiny text-ink transition-colors duration-fast hover:bg-active focus-visible:outline-none focus-visible:shadow-focusring"
              >
                {DETAIL.trace}
              </button>
            )}

            {/* 6. THE ACTIONS. §21: Stop is inline and a single press, because it is scoped to one
                   item and the item is on screen. Retry is the same weight — it creates a new job
                   rather than destroying one. */}
            {live ? (
              <DisabledReason state={cancelState}>
                <button
                  type="button"
                  onClick={() => sendCancelWork(item.id)}
                  disabled={Boolean(cancelState.reason)}
                  className="rounded-control border border-hair px-2.5 py-1 text-tiny text-muted transition-colors duration-fast hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring disabled:pointer-events-none disabled:text-disabled"
                  title={`${STATUS_WORD[item.status]} — ${DESTRUCTIVE_STOP_TITLE}`}
                >
                  Stop
                </button>
              </DisabledReason>
            ) : (
              <DisabledReason state={retryState}>
                <button
                  type="button"
                  onClick={() => sendRetryWork(item.id)}
                  disabled={Boolean(retryState.reason)}
                  className="rounded-control border border-hair px-2.5 py-1 text-tiny text-muted transition-colors duration-fast hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring disabled:pointer-events-none disabled:text-disabled"
                  title="Ask the same thing again, as a new job, on whatever is live now"
                >
                  Retry
                </button>
              </DisabledReason>
            )}

            {/* THE ID, COPYABLE AND CITABLE — Part 2's §12: "`work_items.id` must be stable and
                citable, because Part 3's answers cite it and the citation is clickable." Rendering
                it is what makes that a property somebody can rely on rather than a promise.

                AND IT COPIES A LINK RATHER THAN THE BARE ID — §20: "Give every work item an
                addressable identity SO A FAILED JOB CAN BE PASTED TO A TEAMMATE." A uuid in a chat
                message is a string nobody can do anything with; `jaroku://open?workspace=…` is the
                shape `deepLink.ts` reserved for exactly this, and `workLink.ts` says plainly which
                half of §20's offer was taken: the item is addressable, the receiving handler is
                not built. The chip still SHOWS the id, because that is what a person recognises. */}
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(workLink(workspaceId ?? "", item.id))}
              className="ml-auto transition-opacity duration-fast hover:opacity-80 focus-visible:outline-none focus-visible:shadow-focusring"
              title={DETAIL.copyId}
              aria-label={DETAIL.copyId}
            >
              {/* THROUGH `Chip`'s `mono` PROP RATHER THAN A LOCAL CLASS, which is where the one
                  decision about that face lives. An id IS an identifier, so mono is right here and
                  wrong four lines up. */}
              <Chip mono size="sm" tone="faint">{item.id.slice(0, 8)}</Chip>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** §21's wording for Stop, which is the same sentence the row's control carries. */
const DESTRUCTIVE_STOP_TITLE = "it stops at its next node boundary";
