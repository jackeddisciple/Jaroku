// Nothing leaves the repo that shouldn't — the last look before a tree becomes commits.
//
// §B.6.1 inserts this as a new stage in §2.4's push sequence, between tree-build and commit-create,
// and the position is the point: everything before it is content-addressed and invisible until a
// ref moves, so a refusal here costs some unreferenced blobs GitHub garbage-collects and nothing
// else. A scanner that ran after the ref moved would be a report rather than a gate.
//
// THE DETECTOR IS `deploySecrets`'s, NOT A SECOND ONE, and §B.6.1 says why in one sentence: reusing
// it means a false positive fixed for the build log stays fixed for the push path, instead of the
// two drifting the way the pricing table explicitly guards against elsewhere. What v0.2.4 narrowed
// was the class of mistake this file is one wrong line away from repeating — it scrubbed every host
// value out of the build log, and "anthropic" and "claude-haiku-4-5" are host values, so every
// build log came back reading `langchain-••••••••>=0.3.0`. The lesson it encoded is that SECRECY IS
// A PROPERTY OF THE VALUE, declared where the value is made, and never inferred from where it was
// found. `makeScrubber` is imported below rather than reimplemented for exactly that reason.
//
// AND WHAT IT ADDS, because the scrubber alone is not enough here. A scrubber knows the values it
// was given; a push has to catch a credential nobody has told us about — pasted into a file, or
// left in a `.env` that should never have been in the tree. So there are four surfaces, and each
// one is a different kind of evidence:
//
//   1. KNOWN VALUES. The workspace's own secrets, matched literally. Zero false positives by
//      construction: if a stored credential's exact bytes are in a file, it is that credential.
//   2. TOKEN SHAPES. Prefixed, structured, published formats — `sk-ant-`, `ghp_`, an AWS key id.
//      Not general entropy: see SHAPES below for why guessing at randomness is not done here.
//   3. A `.env` FILE AT ALL. Its presence is the finding, not its contents — see `ENV_FILE`.
//   4. THE MCP MANIFEST'S CREDENTIAL FIELDS. `mcp_tools.json` stores the NAME of an env var and
//      never a value, so a value under one of those keys means somebody edited it by hand.
//
// A FINDING REFUSES, NEVER WARNS. Every other refusal in this product has that posture, and the
// argument is the same: a warning beside a Push button is a warning somebody clicks past. The
// override exists — §B.6.1 puts it under a kebab, matching Force's treatment in §3.6 — and it is
// recorded in `secret_scan_findings` and in `audit_log`.
//
// NO MATCHED VALUE IS EVER RETURNED, LOGGED OR STORED. A `Finding` carries a path, a rule and a
// line. Migration 040's header makes the argument at length: a record of "here is where the
// credentials are, and here is a bit of each one" would be a strictly worse leak than the push it
// prevented.

import { makeScrubber, REDACTION } from "./deploySecrets.ts";
import { MANIFEST_FILE } from "./mcpManifest.ts";
import type { StoredFile } from "./storage/projectStore.ts";

export type FindingKind = "secret" | "artifact";

/**
 * One thing the scanner will not let past.
 *
 * NOTHING IN THIS SHAPE CAN HOLD THE MATCHED TEXT, and that is deliberate rather than incidental:
 * there is no `value`, no `excerpt`, no `hint`. `secret_refs.masked_hint` exists because a user has
 * to recognise their own key in a list of keys; nobody has to recognise anything here.
 */
export interface Finding {
  /** Repository-relative, as the file would have been written. What the user goes and opens. */
  path: string;
  kind: FindingKind;
  /** Which surface matched. Rendered as a sentence — see `RULES`. */
  rule: string;
  /** One-based. Null for a whole-file finding, where pointing at line 1 would imply line 1. */
  line: number | null;
  /** The sentence §B.6.1's card renders under the path. Never quotes the file. */
  message: string;
}

/**
 * Published token formats, by their own prefixes and shapes.
 *
 * NOT AN ENTROPY HEURISTIC, and the absence is the design. "This string looks random" flags a
 * base64-encoded test fixture, a sha256 in a lockfile, a UUID in a comment and a minified line —
 * and a scanner that refuses a push over a lockfile hash is one people learn to override on every
 * push, which is worse than not having it. Every pattern below is a format its ISSUER publishes, so
 * a match is a statement about what the string IS rather than about how random it looks.
 *
 * The same reasoning `mcpImpact.ts` gives for matching tool names exactly rather than by stem: a
 * weak signal that fires often trains people to ignore the strong one beside it.
 */
const SHAPES: { rule: string; re: RegExp; what: string }[] = [
  { rule: "aws_access_key_id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, what: "an AWS access key id" },
  { rule: "aws_secret_key", re: /\baws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}\b/i, what: "an AWS secret key" },
  { rule: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/, what: "an Anthropic API key" },
  { rule: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/, what: "an OpenAI API key" },
  { rule: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/, what: "a GitHub token" },
  { rule: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, what: "a Slack token" },
  { rule: "google_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/, what: "a Google API key" },
  { rule: "stripe_key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/, what: "a Stripe secret key" },
  { rule: "private_key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, what: "a private key block" },
  {
    rule: "connection_string",
    // A URL with a password in it. The `:.+@` is what makes it a credential rather than a host.
    re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/,
    what: "a connection string with a password in it",
  },
];

/**
 * A `.env` file, by name.
 *
 * ITS PRESENCE IS THE FINDING, NOT ITS CONTENTS, and §B.6.1 is explicit: it should never be there
 * given the Quick Start's `.gitignore`, so being in the tree at all is a signal on its own. A
 * scanner that opened it and found nothing recognisable would let through the one whose secrets are
 * in a format nobody has published a regex for — which is most of them, since a database password
 * somebody chose is just a word.
 *
 * `.env.example` IS EXEMPT, and has to be: rule 4 REQUIRES it — a key read from the environment and
 * missing from `.env.example` fails validation — so refusing to push the file the validator demands
 * would make the two gates contradict each other on every agent that reads a credential.
 */
const ENV_FILE = /(^|\/)\.env(\..*)?$/;
const ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template)$/;

/**
 * What counts as "not source".
 *
 * FLAGGED SEPARATELY FROM A SECRET, with its own sentence, because §B.6.1 asks for exactly that:
 * "this repo isn't meant for binary assets" and "this file might be a credential" are different
 * problems and deserve different sentences. Folding them together would point somebody at Git LFS
 * over a leaked key, or at a key rotation over a screenshot.
 */
const MAX_FILE_BYTES = 512 * 1024;

/** A NUL byte in the first few kilobytes. The same test `scan.ts` uses to skip a file. */
function looksBinary(content: string): boolean {
  return content.slice(0, 8192).includes("\u0000");
}

/**
 * Which line a match landed on.
 *
 * Computed from the offset rather than by scanning line by line, because the regexes above are
 * whole-file — several of them span a line boundary — and re-running them per line would both cost
 * more and miss those.
 */
function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

export interface ScanOptions {
  /**
   * The workspace's own secret VALUES, for the literal pass.
   *
   * Passed in rather than read here, and never held: this module is given them for the duration of
   * one call and returns findings that do not contain them. `deploySecrets.resolveSecretValues` has
   * the same shape and the same rule — the only read of a credential in the deploy path, straight
   * into the request body and the scrubber, and nowhere else.
   */
  knownValues?: Iterable<string>;
  /** Override the artifact ceiling. Exists for the suite; no caller in the server sets it. */
  maxFileBytes?: number;
}

/**
 * Every reason this tree must not be pushed.
 *
 * SORTED BY PATH THEN LINE, so a rescan of an unchanged tree produces an identical list and the
 * rows written to `secret_scan_findings` do not churn — the same reasoning `scan.ts` gives for
 * sorting its hits.
 *
 * ONE FINDING PER (path, rule), not one per occurrence. A key pasted into a file three times is one
 * problem with one fix, and three rows would make the card a list of the same sentence.
 */
export function scanTree(files: readonly StoredFile[], opts: ScanOptions = {}): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const maxBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;

  // Built once for the whole tree. `makeScrubber` drops anything under eight characters for the
  // reason it states — a three-character secret matched across a file shreds it — and that floor is
  // exactly right here too: a two-letter "secret" would match half the source.
  const scrub = makeScrubber(opts.knownValues ?? []);

  const add = (f: Finding): void => {
    const key = `${f.path}\u0000${f.rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };

  for (const file of files) {
    const bytes = Buffer.byteLength(file.content, "utf8");

    // --- 3. a .env file, by its name alone -------------------------------------------------
    if (ENV_FILE.test(file.path) && !ENV_EXAMPLE.test(file.path)) {
      add({
        path: file.path,
        kind: "secret",
        rule: "env_file",
        line: null,
        message:
          "this is a .env file — it was never meant to leave your disk, and the Quick Start's .gitignore excludes it. Its presence here is the problem, whatever is inside it.",
      });
      // Deliberately no `continue`. A `.env` in the tree is worth saying twice if it also carries
      // a recognisable key: the second finding tells somebody which credential to rotate, which is
      // the more urgent of the two actions.
    }

    // --- oversized and binary artifacts ----------------------------------------------------
    if (bytes > maxBytes) {
      add({
        path: file.path,
        kind: "artifact",
        rule: "oversized",
        line: null,
        message: `this file is ${Math.round(bytes / 1024)} KB. An agent project is a few kilobytes of Python — if this belongs in the repository, it belongs in Git LFS.`,
      });
      continue;
    }
    if (looksBinary(file.content)) {
      add({
        path: file.path,
        kind: "artifact",
        rule: "binary",
        line: null,
        message:
          "this is a binary file. Nothing in an agent project is binary, and a repository this size is not meant to hold assets — Git LFS is where one belongs.",
      });
      continue;
    }

    // --- 1. the literal pass, against values we actually hold -------------------------------
    //
    // ZERO FALSE POSITIVES BY CONSTRUCTION. This is not a guess about what a string looks like: if
    // a stored credential's exact bytes are in this file, it IS that credential. Detected by
    // scrubbing and comparing rather than by searching, so no value is ever named in a variable
    // here — the scrubber's own reason for using split/join rather than a RegExp built from a
    // credential applies to this call site too.
    const scrubbed = scrub(file.content);
    if (scrubbed !== file.content) {
      add({
        path: file.path,
        kind: "secret",
        rule: "known_value",
        line: lineAt(scrubbed, scrubbed.indexOf(REDACTION)),
        message:
          "this file contains one of this workspace's stored credentials, byte for byte. Whatever it is called here, it is the real value.",
      });
    }

    // --- 2. published token shapes -----------------------------------------------------------
    for (const shape of SHAPES) {
      const match = shape.re.exec(file.content);
      if (!match) continue;
      add({
        path: file.path,
        kind: "secret",
        rule: shape.rule,
        line: lineAt(file.content, match.index),
        message: `this looks like ${shape.what}. Rotate it rather than pushing it — a credential in a commit is a credential in the reflog.`,
      });
    }

    // --- 4. the MCP manifest's credential fields ---------------------------------------------
    if (file.path === MANIFEST_FILE || file.path.endsWith(`/${MANIFEST_FILE}`)) {
      for (const finding of scanManifest(file)) add(finding);
    }
  }

  return findings.sort((a, b) =>
    a.path === b.path ? (a.line ?? 0) - (b.line ?? 0) : a.path < b.path ? -1 : 1,
  );
}

/**
 * `mcp_tools.json`'s credential fields, which are supposed to hold NAMES.
 *
 * `auth_env_key` IS THE NAME OF AN ENVIRONMENT VARIABLE AND NEVER A VALUE — `mcpManifest.ts` says
 * so on the field itself, and the manifest ships inside a project directory a user may well commit,
 * which is precisely why it was designed that way. So the check is not "does this look like a
 * secret" but "is this still a variable name": `[A-Z][A-Z0-9_]*` is what a name is, and anything
 * else under that key is a value somebody pasted by hand.
 *
 * THAT MAKES IT A STRUCTURAL CHECK RATHER THAN A HEURISTIC, which is worth the distinction: a
 * shape-based pass would miss `auth_env_key: "hunter2"` entirely, because a chosen password looks
 * like a word.
 *
 * A MANIFEST THAT DOES NOT PARSE IS NOT A FINDING. It is a broken file, which the validator and the
 * bridge both have opinions about, and refusing a push over malformed JSON would be this stage
 * answering a question that is not its own.
 */
function scanManifest(file: StoredFile): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    return [];
  }
  const servers = (parsed as { servers?: unknown })?.servers;
  if (!Array.isArray(servers)) return [];

  const out: Finding[] = [];
  const NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
  for (const server of servers) {
    if (!server || typeof server !== "object") continue;
    const key = (server as { auth_env_key?: unknown }).auth_env_key;
    if (typeof key !== "string" || key === "" || NAME.test(key)) continue;
    out.push({
      path: file.path,
      kind: "secret",
      rule: "manifest_credential",
      line: lineAt(file.content, file.content.indexOf(key)),
      message:
        "an MCP server's auth_env_key holds the NAME of an environment variable, never its value — and this one is not a variable name. Whatever is there is about to be committed.",
    });
  }
  return out;
}

/**
 * The one-line verdict §B.6.1's refusal card leads with.
 *
 * NAMES THE FIRST FINDING RATHER THAN COUNTING THEM, because a person's next action is to open one
 * file, and "3 problems" is a number they have to click to make useful. The count follows, so
 * nothing is hidden.
 */
export function refusalLine(findings: readonly Finding[]): string {
  const first = findings[0];
  if (!first) return "";
  const rest = findings.length - 1;
  const what = first.kind === "artifact" ? "Push refused — oversized file" : "Push refused — possible secret";
  return rest > 0 ? `${what}: ${first.path}, and ${rest} more` : `${what}: ${first.path}`;
}
