// What each node of an agent's graph is drawn as: one mark, in one colour, never the same as
// another node's in the same graph.
//
// EVERY MODEL-CALLING STEP USED TO WEAR THE SAME ROBOT, so a five-step agent was five identical
// tiles and the picture said nothing a list of names did not. Now a node is drawn by what it DOES,
// read off its name — `extract_jd` is a document being searched, `score_candidate` a chart,
// `shortlist_note` a pen — the way n8n draws a workflow with each service's own mark.
//
// THREE SOURCES, IN ORDER:
//   1. A BRAND, when a word of the node's name names a connector THIS agent has — `send_slack`
//      in an agent with the Slack connector is Slack's own logo. Not merely a word that looks like
//      one: an agent without Slack that has a step called `slack_off` is not drawn as Slack.
//   2. A KIND, from the first word of the name that says one ("extract", "score", "email"…). Each
//      kind has a pool of marks and one hue, so steps of one kind share a colour and differ in mark.
//   3. ANYTHING ELSE draws from a generic pool, in rotating hues, so a graph of unrecognisable
//      names is still a graph of different-looking tiles.
//
// UNIQUE WITHIN A GRAPH, AND THE SAME EVERY TIME: nodes are taken in the order the runtime lists
// them, and a node whose first choice is taken steps to the next unused mark of its kind, then to
// the generic pool. Nothing depends on layout or on chance.

import type { ReactElement } from "react";

import { Icon } from "../lib/icons/registry.ts";
import type { IconComponent } from "../lib/icons/registry.ts";
import { NODE_HUE, TEXT } from "../lib/tokens.ts";
import type { FlowRole } from "../lib/graphLayout.ts";
import { GmailIcon, GoogleCalendarIcon, HttpIcon, PostgresIcon, SlackIcon, StripeIcon } from "./graphIcons.tsx";

export type NodeMark =
  | { kind: "glyph"; key: string; Icon: IconComponent; hue: string }
  | { kind: "brand"; key: string; Icon: (p: { size?: number }) => ReactElement; label: string };

type Kind = {
  id: string;
  /** Matched against each word of a node's name, whole-word. */
  words: RegExp;
  hue: string;
  pool: Array<[string, IconComponent]>;
};

// THE KINDS, MOST SPECIFIC FIRST. A name is read word by word and the first word any kind claims
// decides — `send_invoice` is sending (it is the verb), `invoice_total` is money.
const KINDS: Kind[] = [
  {
    id: "extract",
    words: /^(extract|parse|read|load|ingest|import|scan|pull|get|collect|gather|split|chunk)$/,
    hue: NODE_HUE.blue,
    pool: [["fileSearch", Icon.graphNode.fileSearch], ["scan", Icon.graphNode.scan], ["documentCheck", Icon.graphNode.documentCheck], ["download", Icon.graphNode.download]],
  },
  {
    id: "person",
    words: /^(resume|cv|candidate|candidates|user|users|profile|person|people|applicant|customer|contact|lead|leads|hire|hiring|recruit|job|jobs|role)$/,
    hue: NODE_HUE.indigo,
    pool: [["userSearch", Icon.graphNode.userSearch], ["userAccount", Icon.graphNode.userAccount], ["jobSearch", Icon.graphNode.jobSearch], ["briefcase", Icon.graphNode.briefcase]],
  },
  {
    id: "judge",
    words: /^(score|scores|rank|rate|rating|evaluate|eval|assess|grade|measure|compare|match|weigh|shortlist|select|pick|choose)$/,
    hue: NODE_HUE.violet,
    pool: [["analytics", Icon.graphNode.analytics], ["target", Icon.graphNode.target], ["award", Icon.graphNode.award], ["chartBar", Icon.graphNode.chartBar], ["star", Icon.graphNode.star]],
  },
  {
    id: "sort",
    words: /^(classify|categorize|categorise|label|tag|detect|filter|sort|triage|route|dedupe|group)$/,
    hue: NODE_HUE.cyan,
    pool: [["tag", Icon.graphNode.tag], ["filter", Icon.graphNode.filter], ["filterHorizontal", Icon.graphNode.filterHorizontal]],
  },
  {
    id: "send",
    words: /^(send|email|emails|mail|notify|notification|alert|post|publish|deliver|dispatch|forward|inbox)$/,
    hue: NODE_HUE.pink,
    pool: [["mailSend", Icon.graphNode.mailSend], ["mail", Icon.graphNode.mail], ["sent", Icon.graphNode.sent], ["notification", Icon.graphNode.notification]],
  },
  {
    id: "write",
    words: /^(write|draft|compose|generate|note|notes|reply|respond|response|answer|summarize|summarise|summary|explain|describe|report|letter|message|decline|reject)$/,
    hue: NODE_HUE.teal,
    pool: [["pencilEdit", Icon.graphNode.pencilEdit], ["messageEdit", Icon.graphNode.messageEdit], ["note", Icon.graphNode.note], ["textAlign", Icon.graphNode.textAlign], ["fileEdit", Icon.graphNode.fileEdit]],
  },
  {
    id: "lookup",
    words: /^(search|lookup|find|fetch|query|retrieve|browse|crawl|scrape|web|request)$/,
    hue: NODE_HUE.sky,
    pool: [["search", Icon.graphNode.search], ["globe", Icon.graphNode.globe], ["database", Icon.graphNode.database], ["link", Icon.graphNode.link]],
  },
  {
    id: "think",
    words: /^(think|plan|planner|reason|decide|agent|assistant|brainstorm|idea|ideas|chat|llm|model|ask)$/,
    hue: NODE_HUE.fuchsia,
    pool: [["aiBrain", Icon.graphNode.aiBrain], ["idea", Icon.graphNode.idea], ["aiChat", Icon.graphNode.aiChat], ["brain", Icon.graphNode.brain]],
  },
  {
    id: "check",
    words: /^(check|validate|verify|approve|approval|review|confirm|guard|ensure|audit|test|qa)$/,
    hue: NODE_HUE.green,
    pool: [["checkmark", Icon.graphNode.checkmark], ["shield", Icon.graphNode.shield], ["taskDone", Icon.graphNode.taskDone], ["userCheck", Icon.graphNode.userCheck]],
  },
  {
    id: "reshape",
    words: /^(transform|format|clean|tidy|normalize|normalise|convert|merge|combine|join|enrich|map|reduce|refine|rewrite|fix)$/,
    hue: NODE_HUE.lime,
    pool: [["magicWand", Icon.graphNode.magicWand], ["merge", Icon.graphNode.merge], ["layers", Icon.graphNode.layers]],
  },
  {
    id: "time",
    words: /^(schedule|calendar|meeting|event|events|book|booking|remind|reminder|wait|delay|time|date|deadline)$/,
    hue: NODE_HUE.purple,
    pool: [["calendar", Icon.graphNode.calendar], ["clock", Icon.graphNode.clock], ["hourglass", Icon.graphNode.hourglass]],
  },
  {
    id: "money",
    words: /^(pay|payment|payments|charge|invoice|invoices|price|pricing|cost|budget|refund|billing|order|orders|quote)$/,
    hue: NODE_HUE.emerald,
    pool: [["creditCard", Icon.graphNode.creditCard], ["invoice", Icon.graphNode.invoice], ["calculator", Icon.graphNode.calculator], ["money", Icon.graphNode.money]],
  },
  {
    id: "talk",
    words: /^(translate|translation|conversation|dialog|dialogue|talk|greet|greeting|chatbot)$/,
    hue: NODE_HUE.indigo,
    pool: [["translate", Icon.graphNode.translate], ["message", Icon.graphNode.message], ["chatting", Icon.graphNode.chatting]],
  },
  {
    id: "code",
    words: /^(code|run|execute|exec|api|http|webhook|tool|tools|call|invoke|script|sql|function)$/,
    hue: NODE_HUE.slate,
    pool: [["sourceCode", Icon.graphNode.sourceCode], ["api", Icon.graphNode.api], ["wrench", Icon.graphNode.wrench], ["plug", Icon.graphNode.plug]],
  },
];

// What a name nothing recognises gets, each in the next hue round, so even a graph of such names
// is a graph of different-looking tiles.
const GENERIC: Array<[string, IconComponent]> = [
  ["sparkles", Icon.graphNode.sparkles], ["puzzle", Icon.graphNode.puzzle], ["task", Icon.graphNode.task],
  ["package", Icon.graphNode.package], ["workflow", Icon.graphNode.workflow], ["book", Icon.graphNode.book],
  ["share", Icon.graphNode.share], ["news", Icon.graphNode.news], ["image", Icon.graphNode.image],
  ["location", Icon.graphNode.location], ["cart", Icon.graphNode.cart], ["cloud", Icon.graphNode.cloud],
  ["play", Icon.graphNode.play],
];
const GENERIC_HUES = [
  NODE_HUE.blue, NODE_HUE.violet, NODE_HUE.teal, NODE_HUE.pink, NODE_HUE.sky, NODE_HUE.lime,
  NODE_HUE.indigo, NODE_HUE.emerald, NODE_HUE.fuchsia, NODE_HUE.cyan, NODE_HUE.purple, NODE_HUE.green,
];

/** The marks Start, End and a fork always wear. Not drawn from any pool, so never taken by a step. */
export const FIXED: Record<"start" | "end" | "decision", NodeMark> = {
  start: { kind: "glyph", key: "start", Icon: Icon.graphNode.start, hue: TEXT.ink },
  end: { kind: "glyph", key: "end", Icon: Icon.graphNode.end, hue: TEXT.ink },
  // n8n's If node is a green signpost; a fork is the same idea.
  decision: { kind: "glyph", key: "decision", Icon: Icon.graphNode.decision, hue: NODE_HUE.green },
};

// A connector's logo, and the words in a node's name that mean "this step uses it".
const BRANDS: Array<{ connector: string; words: RegExp; label: string; Icon: (p: { size?: number }) => ReactElement }> = [
  { connector: "slack", words: /^slack$/, label: "Slack", Icon: SlackIcon },
  { connector: "google_calendar", words: /^(calendar|gcal|event|events|meeting|schedule)$/, label: "Google Calendar", Icon: GoogleCalendarIcon },
  { connector: "gmail", words: /^(gmail|email|emails|mail|inbox)$/, label: "Gmail", Icon: GmailIcon },
  { connector: "stripe", words: /^(stripe|payment|payments|charge|invoice|invoices|refund)$/, label: "Stripe", Icon: StripeIcon },
  { connector: "postgres", words: /^(postgres|sql|db|database|query|table)$/, label: "Postgres", Icon: PostgresIcon },
  { connector: "http", words: /^(http|webhook|api|request|fetch)$/, label: "HTTP", Icon: HttpIcon },
];

/** A node name's words: `extract_jd` → extract, jd; `sendSlackMessage` → send, slack, message. */
export function wordsOf(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * A mark for every node of a graph, keyed by node id.
 *
 * `connectors` is the agent's own connector list (`AgentSummary.connectors`): only those are drawn
 * as brands. Nodes are taken in the order given, which is the runtime's, so the answer is stable.
 */
export function marksFor(
  nodes: ReadonlyArray<{ id: string; role: FlowRole }>,
  opts: { connectors?: readonly string[] } = {},
): Map<string, NodeMark> {
  const out = new Map<string, NodeMark>();
  const used = new Set<string>();
  const have = new Set(opts.connectors ?? []);
  const brands = BRANDS.filter((b) => have.has(b.connector));
  let generic = 0;

  const take = (pool: Array<[string, IconComponent]>, hue: string | (() => string)): NodeMark | undefined => {
    for (const [key, Mark] of pool) {
      if (used.has(key)) continue;
      used.add(key);
      return { kind: "glyph", key, Icon: Mark, hue: typeof hue === "function" ? hue() : hue };
    }
    return undefined;
  };
  const fromGeneric = (): NodeMark => {
    const mark = take(GENERIC, () => GENERIC_HUES[generic++ % GENERIC_HUES.length]!);
    if (mark) return mark;
    // More steps than there are marks: the one case where two tiles must share, and they share the
    // generic pool's first mark in different hues rather than leaving a tile blank.
    const [key, Mark] = GENERIC[generic % GENERIC.length]!;
    return { kind: "glyph", key: `${key}#${generic}`, Icon: Mark, hue: GENERIC_HUES[generic++ % GENERIC_HUES.length]! };
  };

  for (const n of nodes) {
    if (n.role === "start" || n.role === "end" || n.role === "decision") {
      out.set(n.id, FIXED[n.role]);
      continue;
    }
    const words = wordsOf(n.id);

    // A tool node is the agent's tools, all of them: its connector's logo when it has exactly one.
    if (n.role === "tool" && brands.length === 1 && !used.has(`brand:${brands[0]!.connector}`)) {
      const b = brands[0]!;
      used.add(`brand:${b.connector}`);
      out.set(n.id, { kind: "brand", key: `brand:${b.connector}`, Icon: b.Icon, label: b.label });
      continue;
    }

    // A CONNECTOR THE AGENT HAS OUTRANKS THE VERB. `send_slack_message` is sending, but in an agent
    // with Slack the logo says more — it is WHERE it sends — so every word is tried for a brand
    // before any is read for a kind.
    let mark: NodeMark | undefined;
    const b = brands.find((x) => words.some((w) => x.words.test(w)) && !used.has(`brand:${x.connector}`));
    if (b) {
      used.add(`brand:${b.connector}`);
      mark = { kind: "brand", key: `brand:${b.connector}`, Icon: b.Icon, label: b.label };
    }
    for (const w of mark ? [] : words) {
      const kind = KINDS.find((k) => k.words.test(w));
      if (kind) {
        mark = take(kind.pool, kind.hue);
        if (mark) break;
      }
    }
    if (!mark && n.role === "tool") mark = take(KINDS.find((k) => k.id === "code")!.pool, NODE_HUE.slate);
    out.set(n.id, mark ?? fromGeneric());
  }
  return out;
}

/** Every hue a mark can be drawn in, for the suite that holds them clear of the status colours. */
export const MARK_HUES: readonly string[] = [...new Set([...KINDS.map((k) => k.hue), ...GENERIC_HUES, NODE_HUE.green, TEXT.ink])];
