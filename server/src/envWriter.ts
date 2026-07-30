// Writing a credential into runtime/.env.
//
// This is the FIRST code in Jaroku that writes to that file. Everything else reads it —
// env.ts here, jaroku_interceptor/env.py on the Python side — and the reason it stayed
// read-only is that the file is the user's, holding their Anthropic key and their database
// URL beside whatever we put there. So the rules are narrow on purpose:
//
//   * The value is never logged, never returned, never echoed to a client, and never held
//     anywhere but the single call that writes it. Callers learn that a key IS SET; they do
//     not learn what is in it. Same discipline as loadRuntimeEnv, which logs key names only.
//
//   * Every other line survives byte-for-byte. An existing key is rewritten in place;
//     a new one is appended. Comments, ordering, blank lines and unrelated keys are not
//     touched, because this file is edited by hand far more often than by us.
//
//   * A value containing a newline is REFUSED. Without that check, pasting
//     "abc\nANTHROPIC_API_KEY=..." into a token field would rewrite the user's API key —
//     the .env format has no escape for a newline, so the only safe answer is to reject it.
//
//   * Nothing is written that cannot be read back IDENTICALLY. The format has no escape
//     sequences at all — the loaders strip one layer of matching quotes and stop — so every
//     candidate line is parsed back with the real parser first, and a value with no faithful
//     representation is refused rather than quietly mangled. A silently altered credential
//     produces a 401 with no explanation anywhere; refusing produces a sentence.
//
//   * The file is chmod 600. It holds secrets, and a credential Jaroku wrote should not be
//     the one that is world-readable.
//
// One consequence worth surfacing rather than hiding: a variable already present in the
// environment beats the file, on both sides, by design. If a key is exported in the user's
// shell, writing it here changes nothing after a restart. setEnvVar detects that case and
// returns a warning, because a token that silently reverts on restart is a genuinely
// baffling bug to hit.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseLine } from "./env.ts";

/** The env var name a server's credential lives under. Derived, so it is never a guess. */
export function authEnvKeyFor(serverId: string): string {
  return `JAROKU_MCP_${serverId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
}

export interface CredentialWriter {
  /** Store a value under `key`. Returns a warning when the write will not take effect. */
  set(key: string, value: string): { ok: boolean; warning: string | null };
  /** Remove `key` entirely. */
  clear(key: string): void;
}

/** Keys this process wrote itself, so a warning fires only for a genuinely foreign value. */
const writtenHere = new Set<string>();

const isKey = (line: string, key: string): boolean => {
  const t = line.trim().replace(/^export\s+/, "");
  return t.startsWith(`${key}=`);
};

/**
 * Render `key=value` as a line the loaders can read back EXACTLY, or return null.
 *
 * The .env format Jaroku reads has no escape sequences — parseLine strips one layer of
 * matching quotes and stops, and env.py does the same, deliberately, so the two sides
 * cannot drift. That means a value containing both quote characters, or a backslash next
 * to a quote, has no faithful representation here.
 *
 * Rather than guess, each candidate rendering is parsed back with the REAL loader and
 * accepted only if it round-trips. A credential that is silently altered on the way to
 * disk produces a 401 with no explanation anywhere; refusing produces a sentence.
 */
function renderLine(key: string, value: string): string | null {
  const candidates =
    value === ""
      ? [`${key}=`]
      : [
          `${key}=${value}`, // bare: how a normal token should look in a hand-edited file
          `${key}="${value}"`,
          `${key}='${value}'`,
        ];
  for (const line of candidates) {
    const parsed = parseLine(line);
    if (parsed && parsed[0] === key && parsed[1] === value) return line;
  }
  return null;
}

/**
 * Write `key=value` into the .env file at `path`, replacing an existing entry in place.
 *
 * The value is used here and nowhere else: it is not logged, not returned, and not stored
 * in any structure that outlives the call.
 */
export function setEnvVar(path: string, key: string, value: string): { ok: boolean; warning: string | null } {
  if (/[\r\n]/.test(value)) {
    // Refusing rather than stripping: a value with a newline in it is not the value the
    // user meant to paste, and silently truncating a credential produces a confusing 401
    // instead of a clear error.
    return { ok: false, warning: "a credential cannot contain a line break" };
  }

  const line = renderLine(key, value);
  if (line === null) {
    return {
      ok: false,
      warning:
        "this credential contains characters the .env format cannot store without altering them " +
        "(a mix of quote characters, or a backslash beside a quote). Set it in your shell instead.",
    };
  }

  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  let next: string;

  if (existing.split("\n").some((l) => isKey(l, key))) {
    next = existing
      .split("\n")
      .map((l) => (isKey(l, key) ? line : l))
      .join("\n");
  } else {
    const body = existing.length && !existing.endsWith("\n") ? `${existing}\n` : existing;
    const header = existing.includes("# MCP server credentials")
      ? ""
      : "\n# MCP server credentials (written by Jaroku; safe to edit or delete by hand)\n";
    next = `${body}${header}${line}\n`;
  }

  writeFileSync(path, next, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // A file we cannot chmod (an odd filesystem, a mount option) is still a file we wrote.
    // Failing the whole write over the permission bits would be the worse outcome.
  }

  // Precedence: whatever is already in the environment wins on the next start. Setting it
  // in-process makes the new token work NOW, which is what the user just asked for.
  const shadowed = key in process.env && !writtenHere.has(key) && process.env[key] !== value;
  process.env[key] = value;
  writtenHere.add(key);

  return {
    ok: true,
    warning: shadowed
      ? `${key} is already set in this server's environment, which takes precedence over runtime/.env. ` +
        `The new value is in effect now, but the old one will win again after a restart — unset it in your shell.`
      : null,
  };
}

/** Remove a key from the file and from this process. */
export function clearEnvVar(path: string, key: string): void {
  if (existsSync(path)) {
    const kept = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => !isKey(l, key))
      .join("\n");
    writeFileSync(path, kept, { encoding: "utf8", mode: 0o600 });
  }
  delete process.env[key];
  writtenHere.delete(key);
}

/** The writer the app uses. `path` is fixed by the server; it is never client-supplied. */
export function fileCredentialWriter(path: string): CredentialWriter {
  return {
    set: (key, value) => {
      const result = setEnvVar(path, key, value);
      // Names only. This is the same line loadRuntimeEnv logs, for the same reason.
      if (result.ok) console.log(`[env] wrote ${key} to runtime/.env`);
      return result;
    },
    clear: (key) => {
      clearEnvVar(path, key);
      console.log(`[env] removed ${key} from runtime/.env`);
    },
  };
}
