// §6's twenty-five presets, and the one rule that makes them a vocabulary rather than a schema.
//
// THIS LIST IS NOT A CONSTRAINT ON ANYTHING. `agents.category` is `TEXT` — I6 is explicit, and the
// reason is short: "the list will change, and a migration to add 'Compliance' to a preset list would
// be absurd." So there is no enum, no check constraint, and no server-side copy of this file. A
// preset and a category somebody typed are the same value by the time either reaches the database,
// and the ONLY difference between them is how much typing it took.
//
// WHICH MEANS THE LIST IS ALLOWED TO BE WRONG, and that is a feature. It is a guess at what
// twenty-five agents are usually for, offered so the common case is one click; "Name your own" is
// underneath it and stores identically. A picker that could only offer these would be a picker that
// tells somebody their agent is not a kind of thing.
//
// GROUPED, AND THE GROUPS ARE NOT STORED EITHER. They exist so a list of twenty-five is scannable —
// five headings of five-ish beats one column of twenty-five — and nothing downstream knows they
// exist. Regrouping is a change to this file and to nothing else.
//
// SORTED WITHIN GROUPS, EXPLICITLY, and asserted. Not because anything indexes it — nothing does,
// unlike the emoji palette and the avatar roster one directory over — but because a list somebody
// maintains by hand drifts into "whatever order they were thought of in", and twenty-five items in
// no order is a list you read all of to find one.
//
//   npm run test:agent-category

/** The value an agent has when nobody has said. The server's `UNCATEGORIZED`, spelled once here. */
export const UNCATEGORIZED = "Uncategorized";

export interface CategoryGroup {
  /** The heading. Not stored, not sent, and safe to reword. */
  label: string;
  /** Sorted. */
  categories: readonly string[];
}

/**
 * The five groups, in the order the picker shows them.
 *
 * ORDER BY EXPECTED USE, not alphabetically: Business first because it is the largest and the
 * commonest, General last because it is the fallback. A picker whose first heading is "Content"
 * makes somebody read all five to find the one they wanted.
 */
export const CATEGORY_GROUPS: readonly CategoryGroup[] = [
  {
    label: "Business",
    categories: ["Billing", "Email Triage", "Marketing", "Outreach", "Sales", "Scheduling", "Social Media", "Support"],
  },
  {
    label: "Data",
    categories: ["Analytics", "Data Entry", "Monitoring", "Reporting", "Research", "Scraping"],
  },
  {
    label: "Engineering",
    categories: ["Code Review", "Coding", "Debugging", "DevOps", "Testing"],
  },
  {
    label: "Content",
    categories: ["Design", "Documentation", "Summarization", "Translation", "Writing"],
  },
  {
    label: "General",
    categories: ["Personal Assistant"],
  },
];

/** All twenty-five, flat, in group order. What a search filters and what the suite counts. */
export const AGENT_CATEGORIES: readonly string[] = CATEGORY_GROUPS.flatMap((g) => g.categories);

/**
 * Is this one of the presets?
 *
 * FOR THE INTERFACE, NEVER FOR A GUARD. It decides whether the picker shows a preset as selected or
 * drops into its "name your own" field with the value in it — a question about which control to
 * highlight, not about whether a value is allowed. Nothing validates against this, and nothing
 * should: a category that stopped being a preset would otherwise become unsaveable on every agent
 * already carrying it.
 */
export function isPresetCategory(value: string): boolean {
  return AGENT_CATEGORIES.includes(value.trim());
}

/**
 * What to store for what somebody typed.
 *
 * TRIMMED, AND EMPTY MEANS NEUTRAL. The column is NOT NULL, so "" would render as a name followed by
 * an em dash and nothing at all — which reads as a bug rather than as an absence. The server does
 * the same normalisation in `setCategory`; this is here so the interface can show what will be
 * stored before it is stored, rather than showing one thing and saving another.
 */
export function normalizeCategory(value: string): string {
  return value.trim() || UNCATEGORIZED;
}

/**
 * Does this category get shown beside the agent's name?
 *
 * §7: "If the category is Uncategorized, show the name alone rather than the placeholder." An agent
 * nobody has categorised is the common case in a workspace that predates this feature, and "— 
 * Uncategorized" after every name is a column of noise that says nothing about any of them.
 */
export function showsCategory(category: string | null | undefined): category is string {
  return Boolean(category) && category !== UNCATEGORIZED;
}
