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

/**
 * A positive number from the environment, or the default.
 *
 * Every timeout in the deploy layer used `Number(process.env.X ?? default)`, and `Number` of
 * a typo is NaN. NaN does not fail loudly — it fails silently and backwards: `Date.now() <
 * Date.now() + NaN` is FALSE, so a mistyped JAROKU_DEPLOY_FOLLOW_MS meant the loop watching a
 * build never ran a single iteration and every deploy reported itself interrupted a
 * millisecond after starting. A configuration typo should cost you the setting, not the
 * feature.
 *
 * Zero and negatives fall back too. A timeout of zero is not a fast timeout, it is a broken
 * one, and it would break in the same silent direction.
 */
export function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[env] ${name}=${raw} is not a positive number — using ${fallback}`);
    return fallback;
  }
  return parsed;
}
