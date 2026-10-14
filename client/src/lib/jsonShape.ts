// The shape of a JSON value, as the trace's JSON viewer (components/JsonTree.tsx) draws it: how many
// lines it takes pretty-printed — its gutter's numbers — what type each value is, and where a search
// lands. Pure, so it is tested without a DOM.
//
//   npm run test:trace-view

const lineMemo = new WeakMap<object, number>();
/** How many lines a value takes pretty-printed: one for a leaf or an empty branch, else its brackets and its children. */
export function jsonLines(value: unknown): number {
  if (value === null || typeof value !== "object") return 1;
  const hit = lineMemo.get(value);
  if (hit !== undefined) return hit;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  const n = children.length === 0 ? 1 : 2 + children.reduce<number>((acc, c) => acc + jsonLines(c), 0);
  lineMemo.set(value, n);
  return n;
}

/** What a value is, as its badge says it: `string`, `number`, `array[3]`, `object{5}`. */
export function jsonType(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === "object") return `object{${Object.keys(value).length}}`;
  if (typeof value === "boolean") return "bool";
  return typeof value;
}

export const has = (text: string, q: string): boolean => q !== "" && text.toLowerCase().includes(q);
/** Whether a value, or any key or value inside it, holds the search. */
export function holds(value: unknown, q: string): boolean {
  if (value === null || typeof value !== "object") return has(String(value), q);
  return Array.isArray(value)
    ? value.some((v) => holds(v, q))
    : Object.entries(value as Record<string, unknown>).some(([k, v]) => has(k, q) || holds(v, q));
}
/** How many keys and values hold the search. */
export function jsonMatches(value: unknown, q: string, key?: string): number {
  const own = key !== undefined && has(key, q) ? 1 : 0;
  if (value === null || typeof value !== "object") return own + (has(String(value), q) ? 1 : 0);
  return own + (Array.isArray(value)
    ? value.reduce<number>((acc, v) => acc + jsonMatches(v, q), 0)
    : Object.entries(value as Record<string, unknown>).reduce<number>((acc, [k, v]) => acc + jsonMatches(v, q, k), 0));
}

