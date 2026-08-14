// Reading a bundle of credentials somebody exported from somewhere else.
//
// WHAT THIS IS AND IS NOT. It is a PARSER: text in, `{name, value}` pairs out, with everything it
// refused and why. It is not an integration with 1Password, Vault or Doppler — there is no API
// client here, no vendor OAuth app, and nothing that reaches out to anybody. Each of those tools
// can already produce a file or a clipboard's worth of text, and reading what they emit is the
// part that belongs in this repository. A live integration with three vendors is three OAuth apps
// and three token lifecycles, which is a feature of its own rather than a corner of this one.
//
// FOUR SHAPES, chosen because between them they cover what those tools actually emit:
//
//   dotenv       KEY=value lines. What `doppler secrets download --no-file --format env`,
//                `vault kv get -format=env` and 1Password's "export as .env" all produce.
//   flat json    {"NAME": "value"}. `doppler secrets download --format json` in its plain form.
//   doppler      {"NAME": {"computed": "value", ...}}. Doppler's richer JSON.
//   vault kv2    {"data": {"data": {"NAME": "value"}}}. What `vault kv get -format=json` wraps a
//                KV-v2 secret in, and the shape people paste most often by accident.
//
// The format is DETECTED rather than declared, because somebody pasting a blob does not
// necessarily know which of those four their tool produced — and getting it wrong should be a
// parse that finds nothing rather than a parse that finds the wrong thing.
//
// NOTHING HERE LOGS, RETURNS OR RETAINS A VALUE BEYOND ITS RETURN. The parsed values exist as
// locals inside one call and are handed straight to `SecretStore.set` by the caller. `describe`
// exists precisely so a caller can report what happened WITHOUT holding the values to do it.

import { isSecretName, unstorableReason } from "./secretStore.ts";

export type BundleFormat = "dotenv" | "json" | "doppler" | "vault";

export interface ParsedSecret {
  name: string;
  value: string;
}

/** A line that could not become a credential, and the reason — never the value it carried. */
export interface RejectedSecret {
  /** What it called itself, when that much was readable. Truncated: it is untrusted input. */
  name: string;
  reason: string;
}

export interface ParsedBundle {
  format: BundleFormat;
  secrets: ParsedSecret[];
  rejected: RejectedSecret[];
}

/** Names are attacker-controlled here. Bounded before it reaches a message or a log line. */
function safeName(raw: unknown): string {
  const s = typeof raw === "string" ? raw : String(raw);
  return s.slice(0, 64).replace(/[\r\n]/g, " ");
}

/**
 * Strip one layer of matching quotes, the way a `.env` loader does.
 *
 * Deliberately narrow: only when the first and last characters match, only for `'` and `"`, and
 * with no escape processing. A value that arrives quoted was quoted by the exporter, and guessing
 * further — unescaping `\n`, say — would mean storing something the user never had.
 */
function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

function parseDotEnv(text: string): { secrets: ParsedSecret[]; rejected: RejectedSecret[] } {
  const secrets: ParsedSecret[] = [];
  const rejected: RejectedSecret[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // `export FOO=bar` is what a shell-oriented export looks like, and refusing it would refuse
    // the most common thing somebody pastes.
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) {
      rejected.push({ name: safeName(withoutExport), reason: "not a NAME=value line" });
      continue;
    }
    secrets.push({
      name: withoutExport.slice(0, eq).trim(),
      value: unquote(withoutExport.slice(eq + 1)),
    });
  }
  return { secrets, rejected };
}

/** `{"NAME": "value"}`, and the two nested shapes that reduce to it. */
function parseFlatObject(obj: Record<string, unknown>): { secrets: ParsedSecret[]; rejected: RejectedSecret[] } {
  const secrets: ParsedSecret[] = [];
  const rejected: RejectedSecret[] = [];
  for (const [name, raw] of Object.entries(obj)) {
    if (typeof raw === "string") {
      secrets.push({ name, value: raw });
      continue;
    }
    // Doppler's richer JSON gives an object per name; `computed` is the resolved value and `raw`
    // the one before interpolation. The computed one is what a run would have received.
    if (raw && typeof raw === "object") {
      const holder = raw as Record<string, unknown>;
      const value = holder["computed"] ?? holder["raw"] ?? holder["value"];
      if (typeof value === "string") {
        secrets.push({ name, value });
        continue;
      }
    }
    // A number or a boolean is somebody's config, not a credential, and coercing it would import
    // things they did not mean to move.
    rejected.push({ name: safeName(name), reason: "the value is not text" });
  }
  return { secrets, rejected };
}

/**
 * Work out what this is and read it.
 *
 * Detection order matters: the nested shapes are checked before the flat one, because a Vault KV-v2
 * document IS a valid flat object whose single key is `data` — reading it as flat would import one
 * credential called `data` and silently drop every real one.
 */
export function parseSecretBundle(text: string): ParsedBundle {
  const trimmed = text.trim();
  if (!trimmed) return { format: "dotenv", secrets: [], rejected: [] };

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Falls through to dotenv rather than failing: a `.env` file whose first line happens to be
      // a comment containing a brace is not JSON, and refusing it outright would be unhelpful.
      const out = parseDotEnv(text);
      return { format: "dotenv", ...out };
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;

      // Vault KV v2: {"data": {"data": {...}, "metadata": {...}}}
      const data = obj["data"];
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const inner = (data as Record<string, unknown>)["data"];
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          return { format: "vault", ...parseFlatObject(inner as Record<string, unknown>) };
        }
      }

      // Doppler's richer form is a flat object whose values are objects with `computed`.
      const looksDoppler = Object.values(obj).some(
        (v) => v && typeof v === "object" && !Array.isArray(v) && "computed" in (v as object),
      );
      return { format: looksDoppler ? "doppler" : "json", ...parseFlatObject(obj) };
    }
  }

  const out = parseDotEnv(text);
  return { format: "dotenv", ...out };
}

export interface ValidatedBundle {
  format: BundleFormat;
  /** Ready to store, in the order they appeared. */
  accepted: ParsedSecret[];
  rejected: RejectedSecret[];
}

/**
 * Apply the same rules a single credential goes through, to every entry in a bundle.
 *
 * ONE GATE FOR BOTH PATHS. A bulk import that accepted a name `set` would refuse, or a value
 * `envWriter` cannot round-trip, would be a back door into the store around the rules the single
 * path enforces — and the failure would surface much later, as a run receiving a credential that
 * had been quietly mangled.
 *
 * Later entries win on a duplicate name, which is what a `.env` loader does and therefore what
 * somebody pasting one expects.
 */
export function validateBundle(parsed: ParsedBundle): ValidatedBundle {
  const accepted: ParsedSecret[] = [];
  const rejected: RejectedSecret[] = [...parsed.rejected];
  const seen = new Map<string, number>();

  for (const entry of parsed.secrets) {
    if (!isSecretName(entry.name)) {
      rejected.push({
        name: safeName(entry.name),
        reason: "a credential name must be UPPER_SNAKE_CASE, start with a letter, and be at most 128 characters",
      });
      continue;
    }
    const unstorable = unstorableReason(entry.value);
    if (unstorable) {
      rejected.push({ name: entry.name, reason: unstorable });
      continue;
    }
    // An empty value is almost always a placeholder in an exported template rather than a
    // credential somebody meant to move, and storing one turns "not configured" into an opaque
    // 401 from a third party at the point of use.
    if (entry.value === "") {
      rejected.push({ name: entry.name, reason: "the value is empty" });
      continue;
    }
    const at = seen.get(entry.name);
    if (at !== undefined) accepted[at] = entry;
    else {
      seen.set(entry.name, accepted.length);
      accepted.push(entry);
    }
  }

  return { format: parsed.format, accepted, rejected };
}

/**
 * What happened, in a shape that cannot carry a value.
 *
 * The route answers with this rather than with the bundle, so there is no version of the import
 * response that contains a credential — the same discipline as the health counts, applied to a
 * different endpoint.
 */
export function describe(bundle: ValidatedBundle): {
  format: BundleFormat;
  imported: string[];
  rejected: RejectedSecret[];
} {
  return {
    format: bundle.format,
    imported: bundle.accepted.map((s) => s.name),
    rejected: bundle.rejected,
  };
}
