// The development secret store: `runtime/.env`, exactly as it has always been.
//
// This is a WRAPPER, not a reimplementation, and the distinction is the point. `envWriter.ts`
// stays byte-for-byte the module it was — the round-trip refusal, the in-place rewrite that
// leaves every other line alone, the chmod 600, the shadowed-variable warning, and the
// `test:env-writer` suite that defends all four. None of that is re-derived here. What this
// adds is the interface those behaviours now sit behind, so the same call sites work against a
// KMS-backed store in production without knowing which one they got.
//
// The spec is explicit that envWriter "keeps its job locally and loses it in production. Do not
// delete it — it is the local implementation, and its round-trip refusal test is worth
// keeping." So there is still exactly ONE writer of that file, and this holds a reference to it
// rather than opening its own.
//
// WHAT IT DOES NOT PRETEND. `runtime/.env` is a single file on one machine with no notion of a
// workspace in it. So:
//
//   * `set` and `delete` take a context and IGNORE its workspace, because there is nowhere in
//     the format to put one. That is honest for the local path — one developer, one machine,
//     the trust boundary this product has always had locally — and it is exactly why the
//     hosted store exists and why this one refuses to run under NODE_ENV=production.
//
//   * `getForRun` does not resolve the run's workspace either, for the same reason. It answers
//     from the process environment, which is what the local runner has always inherited.
//
// Both facts are asserted in the tests rather than left implied, so the day somebody points
// this at a multi-tenant deployment the failure is a refusal at boot and not a shared key.

import { existsSync, readFileSync } from "node:fs";
import { parseLine } from "../env.ts";
import type { CredentialWriter } from "../envWriter.ts";
import type { TenantContext } from "../db/tenant.ts";
import {
  assertSecretName, type SecretRef, type SecretStore, type SetResult,
} from "./secretStore.ts";

export interface DotEnvSecretStoreOptions {
  /** The one writer of `runtime/.env`. Injected, so there is still exactly one. */
  writer: CredentialWriter;
  /** The file it writes, for reading names back. Fixed by the server; never client-supplied. */
  envPath: string;
  /** What each name is for, when the caller knows. Display only — nothing branches on it. */
  providerFor?: (name: string) => string | null;
}

/** Names that are Jaroku's own plumbing rather than a user's credential. Never listed. */
const NOT_A_SECRET = /^(JAROKU_(?!MCP_)|NODE_|PATH$|HOME$|PWD$|SHELL$|LANG$|TERM$)/;

export class DotEnvSecretStore implements SecretStore {
  readonly kind = "dotenv" as const;
  /** When a name was last handed to a run. In memory: this store has nowhere else to put it. */
  private lastUsed = new Map<string, string>();

  constructor(private readonly opts: DotEnvSecretStoreOptions) {}

  async set(_ctx: TenantContext, name: string, value: string): Promise<SetResult> {
    // The name is validated HERE and not only in the hosted store, so a name that would be
    // refused in production is refused in development too. A rule enforced on one path is a
    // rule somebody discovers on the other path, in production, with a user watching.
    assertSecretName(name);
    return this.opts.writer.set(name, value);
  }

  /**
   * The values a run's environment needs.
   *
   * From `process.env`, which is where `loadRuntimeEnv` put the file's contents at boot and
   * where an exported shell variable already lives — the same precedence both loaders follow,
   * and the reason `set` warns when a name is shadowed.
   *
   * The run id is accepted and unused. It is not decoration: it is the parameter the hosted
   * store resolves a workspace from, and a local store that took a different signature would
   * make the call site implementation-specific, which is the one thing an interface is for.
   */
  async getForRun(_runId: string, names: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const at = new Date().toISOString();
    for (const name of names) {
      const value = process.env[name];
      // Absent rather than empty. A blank value would turn "you have not configured this" into
      // a 401 from somebody else's API with nothing pointing at the cause.
      if (typeof value === "string" && value.length > 0) {
        out[name] = value;
        this.lastUsed.set(name, at);
      }
    }
    return out;
  }

  /**
   * What is configured, by name.
   *
   * Read back out of the file with the REAL parser rather than a regex, so what is reported as
   * configured is what the loaders would actually load — a line this store cannot parse is a
   * line a run would not receive either, and listing it would be a lie the user acts on.
   */
  async listNames(_ctx: TenantContext): Promise<SecretRef[]> {
    const names = new Set<string>();
    if (existsSync(this.opts.envPath)) {
      for (const line of readFileSync(this.opts.envPath, "utf8").split("\n")) {
        const parsed = parseLine(line);
        // A name present with an empty value is a placeholder, not a credential — that is what
        // `.env.example` is made of, and reporting it as configured would make the client show
        // a green tick for a key nobody has set.
        if (parsed && parsed[1].length > 0) names.add(parsed[0]);
      }
    }
    // Anything exported in the shell is configured too, and beats the file. Filtered to the
    // names that could plausibly be a credential, because the alternative is listing the
    // developer's entire environment back to a browser.
    for (const [name, value] of Object.entries(process.env)) {
      if (value && !NOT_A_SECRET.test(name) && /^[A-Z][A-Z0-9_]*$/.test(name) && this.lastUsed.has(name)) {
        names.add(name);
      }
    }
    return [...names]
      .filter((name) => !NOT_A_SECRET.test(name))
      .sort()
      .map((name) => ({
        name,
        configured: true as const,
        provider: this.opts.providerFor?.(name) ?? null,
        lastUsedAt: this.lastUsed.get(name) ?? null,
      }));
  }

  async delete(_ctx: TenantContext, name: string): Promise<void> {
    assertSecretName(name);
    this.opts.writer.clear(name);
    this.lastUsed.delete(name);
  }
}
