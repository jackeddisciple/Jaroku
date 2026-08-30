// Question or command, decided before the message is sent — Part 3 §6.
//
// TWO OUTCOMES, AND GETTING IT WRONG IS NOT SYMMETRIC. §6 opens with the reason this module is
// careful: "a question mistaken for a command spends real money and touches the real world." The
// reverse costs a rephrase. So where the signals do not decide, this answers QUESTION — a read
// against the record has no side effects at all, and the label above the composer is what tells
// somebody to rephrase.
//
// DETERMINISTIC, NO PER-MESSAGE MODEL CALL. `lib/intent.ts` made this choice first and stated the
// reason — "a mis-route just needs a rephrase, so the cost of a classifier isn't warranted" — and
// the same reasoning holds here for a different reason: a model call per keystroke is not a thing a
// LIVE label can be built out of. The destination has to be on screen while somebody types, which
// rules out anything with a round trip in it.
//
// AND IT IS A SECOND CLASSIFIER, NOT AN EXTENSION OF THE FIRST. §6: "Do not extend `lib/intent`'s
// table; a real job must never be routable into `edit`." That table routes by (selection context +
// phrasing) into plan / revise / explain / branch / fix / edit — six destinations, all of which
// change or explain an agent's CODE. This one has two, and one of them is a live container. If the
// two tables were one, "refund order 4471 — the customer said it never arrived" would be one
// keyword away from being read as an edit instruction and turned into a code change to the agent
// that was supposed to do it. Two modules is what makes that impossible rather than unlikely.
//
// WHAT THIS DELIBERATELY DOES NOT DO IS DECIDE WHICH AGENT (§12). It takes a sentence and returns a
// route; the agent comes from the thread. "Who can do X?" is a dispatcher across agents, it is Part
// 4, and a classifier that took an agent id would be the first thing to have to change.

/**
 * Where a message in an operate thread is going.
 *
 * A `confidence` TRAVELS WITH IT, and it is not used to decide anything — the route is the route.
 * It is here because §16 asks for a NUMBER rather than a claim about accuracy, and a corpus can
 * only report one if the module says how sure it was. `weak` is the bucket that matters: those are
 * the phrasings that read like both, and their accuracy is the figure worth quoting.
 */
export type OperateRoute = {
  kind: "question" | "command";
  confidence: "strong" | "weak";
};

/**
 * The verbs that make a sentence an instruction.
 *
 * A CURATED LIST RATHER THAN "ANY VERB", because English has no morphology that separates an
 * imperative from a bare infinitive and a part-of-speech tagger is a model call by another name.
 * What is in it: verbs whose object is the WORLD — a message sent, a payment moved, a record
 * written, a person notified. What is deliberately NOT in it: `check`, `find`, `look`, `see`,
 * `tell`, `show`, `list`, `read`, `review` — every one of which is far more often somebody asking
 * to be shown something than asking for it to be done, and each of which would send a question to a
 * live container the first time it was used.
 *
 * `check` IS THE ONE WORTH ARGUING ABOUT. "check the inbox" is an instruction and "check if the
 * invoice went out" is a question, and no rule separates them by the verb. It is out, because §6's
 * asymmetry decides ties: being asked to rephrase "check the inbox" costs a sentence, and having
 * "check whether that refund went through" dispatched costs a refund.
 */
const ACTION_VERBS = [
  "send", "email", "mail", "reply", "respond", "forward", "message", "notify", "remind", "ping",
  "post", "publish", "tweet", "announce",
  "refund", "charge", "pay", "invoice", "bill", "reimburse",
  "create", "make", "add", "draft", "write", "generate", "build", "produce",
  "update", "edit", "change", "set", "rename", "move", "assign", "tag",
  "delete", "remove", "cancel", "close", "archive", "clear", "revoke",
  "schedule", "book", "reschedule", "postpone", "arrange",
  "run", "start", "trigger", "execute", "process", "retry", "rerun", "restart", "kick",
  "sync", "import", "export", "upload", "download", "fetch", "pull", "push", "sync",
  "order", "buy", "purchase", "renew", "subscribe", "unsubscribe",
  "escalate", "approve", "reject", "confirm", "decline", "accept",
  "onboard", "invite", "provision", "deploy", "release", "roll",
] as const;

const VERB = new Set<string>(ACTION_VERBS);

/**
 * Words that open a question, and every one of them is a word this classifier trusts absolutely.
 *
 * A sentence starting `did`, `does`, `is`, `what`, `why`, `how many` is a question in English and
 * there is no reading of it that spends money. These are the `strong` half of the answer.
 */
const QUESTION_OPENERS = new Set([
  "did", "do", "does", "is", "are", "was", "were", "has", "have", "had", "am",
  "what", "whats", "why", "how", "when", "where", "which", "who", "whose", "whom",
  "any", "anything", "everything", "status",
]);

/**
 * Polite wrappers that turn an instruction into a question SHAPE without making it one.
 *
 * "Can you send the invoice?" ends in a question mark, opens with an interrogative, and is an
 * instruction — which is why it cannot be settled by punctuation or by the first word. What settles
 * it is what follows: a wrapper plus an action verb is a command, and a wrapper with no action verb
 * ("can you tell me what happened?") is a question.
 */
const POLITE = [
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?/i,
  /^(?:please)\s+/i,
  /^(?:i\s+(?:need|want)\s+you\s+to|i'd\s+like\s+you\s+to|id\s+like\s+you\s+to)\s+/i,
  /^(?:go\s+ahead\s+and|now)\s+/i,
];

/**
 * Phrases that are about the record even when an action verb is in them.
 *
 * THE FAILURE THESE PREVENT IS THE EXPENSIVE ONE. "Did you send the invoice?" contains `send`; so
 * does "why did that refund fail?" and "has the email gone out yet?". A classifier that looked for a
 * verb anywhere in the sentence would dispatch all three. Every pattern here is a form that asks
 * ABOUT an action rather than for one.
 */
const ABOUT_THE_RECORD = [
  /\b(?:did|have|has|had)\s+(?:you|it|that|this|we|they)\b/i,
  /\bwhat\s+(?:did|have|has|happened|went|was|is|are)\b/i,
  /\bwhy\s+(?:did|does|is|was|were|has|have)\b/i,
  /\bhow\s+(?:many|much|long|often|did|does)\b/i,
  /\b(?:ever|already|yet)\s*\?/i,
  /\bwhat(?:'s| is| was)\s+the\s+(?:status|outcome|result|error|cost)\b/i,
  /\b(?:last|most recent|latest)\s+(?:time|run|job|one)\b/i,
  /\banything\s+(?:waiting|failed|failing|blocked|outstanding|pending)\b/i,
];

/** Strip a vocative: `Tracey, send the invoice` is the same instruction without the name. */
const VOCATIVE = /^[\p{L}][\p{L}\p{N}_ -]{0,40}?,\s+/u;

/** The first word, lower-cased and stripped of punctuation. */
function head(text: string): string {
  return (text.match(/[\p{L}']+/u)?.[0] ?? "").toLowerCase().replace(/'/g, "");
}

/**
 * Where this message goes, and how sure that is.
 *
 * THE ORDER IS THE DESIGN, and every rung is a decision:
 *
 *   1. An empty message goes nowhere, reported as a question because that is the harmless one.
 *   2. A POLITE WRAPPER plus an action verb is a command however it is punctuated. "Could you please
 *      cancel that order?" is not a question about cancellation.
 *   3. A phrase that is ABOUT the record wins over any verb inside it. This is the rung that stops
 *      "did you send the invoice?" from sending an invoice, and it is the most important one here.
 *   4. A question opener is a question.
 *   5. A QUESTION MARK is a question, and it sits ABOVE the imperative check on purpose: "send the
 *      invoice?" is somebody thinking aloud as often as it is a terse instruction, and §6 decides
 *      ties in favour of the reading that spends nothing. Weakly, because it is a tie.
 *   6. An action verb in the first position is a command — a bare imperative.
 *   7. Anything else is a question, weakly. §6's asymmetry decides the default.
 */
export function classifyOperate(text: string): OperateRoute {
  const raw = text.trim();
  if (!raw) return { kind: "question", confidence: "weak" };

  // The vocative is stripped for CLASSIFICATION only. "Tracey, did you send it?" and "did you send
  // it?" are the same question, and "Tracey, send it" and "send it" are the same instruction.
  const body = raw.replace(VOCATIVE, "").trim() || raw;

  for (const wrapper of POLITE) {
    const m = wrapper.exec(body);
    if (!m) continue;
    const rest = body.slice(m[0].length).trim();
    if (VERB.has(head(rest))) return { kind: "command", confidence: "strong" };
    // A wrapper with no action verb after it — "can you tell me what happened?" — is a question,
    // and a confident one: the wrapper was the only thing making it look like an instruction.
    return { kind: "question", confidence: "strong" };
  }

  // BEFORE THE VERB CHECK, DELIBERATELY. Every pattern here contains a sentence that may also
  // contain an action verb, and the whole point is that asking about an action is not asking for it.
  if (ABOUT_THE_RECORD.some((re) => re.test(body))) {
    return { kind: "question", confidence: "strong" };
  }

  const first = head(body);
  if (QUESTION_OPENERS.has(first)) return { kind: "question", confidence: "strong" };

  // A QUESTION MARK, AND IT COMES BEFORE THE IMPERATIVE CHECK RATHER THAN AFTER IT.
  //
  // The case this decides is "send the invoice?" — a bare imperative somebody put a question mark
  // on. It is genuinely ambiguous: it might be a terse instruction, and it might be "shall we send
  // the invoice?" with the front half left off. §6 decides ties, and it decides them the same way
  // every time: the reading that spends money has to be the one somebody asked for clearly. A
  // person who means it can drop the question mark; a person who was thinking aloud does not get an
  // invoice sent to their customer.
  //
  // It costs nothing on the polite forms, which were settled two rungs above: "can you send the
  // invoice?" ends in a question mark and is still a command, because the wrapper plus a verb is
  // what decides it rather than the punctuation.
  if (body.endsWith("?")) return { kind: "question", confidence: "weak" };

  // A BARE IMPERATIVE. The verb has to be FIRST — a verb anywhere in the sentence is how "the
  // invoice you sent yesterday" becomes a dispatch.
  if (VERB.has(first)) return { kind: "command", confidence: "strong" };

  // §6'S ASYMMETRY, AS THE DEFAULT. Nothing decided, so this is a read against the record: no
  // dispatch, no spend, no side effect, and a visible label saying so.
  return { kind: "question", confidence: "weak" };
}

/**
 * The one-line destination label — §6, and it is LOUDER here than the build composer's.
 *
 * "The build composer shows a live one-line label of where the message will go... Here it matters
 * more, so it is louder: 'This will run Tracey' versus 'This reads the record'." Those two sentences
 * are the specification's own and are used verbatim, because the whole function of the label is
 * that a person reads it without meaning to, and a paraphrase is a sentence somebody has to parse.
 *
 * THE AGENT IS NAMED IN THE COMMAND CASE AND NOT IN THE QUESTION CASE, which is deliberate rather
 * than an inconsistency: the name is what makes "this will run Tracey" a warning about something in
 * the world, and "this reads the record about Tracey" would put the same weight on the harmless one.
 */
export function operateLabel(route: OperateRoute, agentName: string): string {
  return route.kind === "command" ? `This will run ${agentName}` : "This reads the record";
}
