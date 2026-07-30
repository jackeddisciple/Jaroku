// Minimal .env loader for the Node side — mirrors runtime/jaroku_interceptor/env.py.
//
// The generator needs ANTHROPIC_API_KEY, and the key lives in runtime/.env (gitignored)
// alongside the provider keys the Python agent uses. Same precedence rule as the Python
// loader: a variable already in the environment always wins, so shell env and CI secrets
// still override the file.
//
// Never logs values — only the names of the keys it set, and only to the server console.

import { existsSync, readFileSync } from "node:fs";

/**
 * Exported so envWriter can prove a line it is about to write reads back identically —
 * against THIS parser rather than a copy of it, which could drift. Note there is no escape
 * handling here, deliberately: this mirrors env.py, and the two must agree.
 */
export function parseLine(line: string): [string, string] | null {
  let text = line.trim();
  if (!text || text.startsWith("#")) return null;
  if (text.startsWith("export ")) text = text.slice("export ".length).trimStart();

  const eq = text.indexOf("=");
  if (eq < 0) return null;

  const key = text.slice(0, eq).trim();
  if (!key) return null;

  let value = text.slice(eq + 1).trim();
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "'" || value[0] === '"')) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

/** Load KEY=VALUE pairs into process.env without overwriting anything already set. */
export function loadRuntimeEnv(path: string): string[] {
  if (!existsSync(path)) return [];

  const loaded: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (key in process.env) continue;
    process.env[key] = value;
    loaded.push(key);
  }
  return loaded;
}
