// The sliver of Node this package's TEST suites need, and nothing else.
//
// The client has no `@types/node` on purpose: it is a browser bundle, and pulling in Node's
// globals would let `process`, `Buffer` and `fs` typecheck inside components that must never
// touch them — a mistake that compiles is a mistake that ships. But the suites run under
// `tsx`, and one of them (store/reset.test.ts) has to read the store directory, because an
// assertion over a hard-coded list of stores is an assertion that goes stale exactly when it
// matters.
//
// So: ambient declarations for the two functions that suite uses. Adding to this file should
// feel like a decision, which is why it is this short and says so.

declare module "node:fs" {
  export function readdirSync(path: string): string[];
  /** Recursive, for the browser-storage audit: it reads every source file looking for keys. */
  export function readdirSync(path: string, options: { recursive: true }): string[];
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
