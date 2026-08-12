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
//
// IT STILL RECORDS ITS NAMES IN `secret_refs`. That is the one place this store is NOT purely a
// wrapper, and the reason is that the registry is store-agnostic: a client asking what is
// configured must get the same answer whichever store answered it, or the panel behaves
// differently depending on how the server was deployed. The values stay in the file; only the
// names, what they are for, and when a run last received one go in the table.

import { existsSync, readFileSync } from "node:fs";
import { parseLine } from "../env.ts";
import type { CredentialWriter } from "../envWriter.ts";
import type { TenantContext } from "../db/tenant.ts";
import type { SecretRefRepository } from "../db/repositories/secretRefs.ts";
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
  /**
   * The store-agnostic name registry.
   *
   * Optional, and the one thing here that is: this store predates the table and has to keep
   * working without a database — `test:env-writer` and the secret suite both construct it with
   * nothing but a file, and a migration that has not run yet must not break `npm run dev`.
   * Absent, `listNames` falls back to reading the file, which is what it did before.
   */
  refs?: SecretRefRepository;
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
    const written = this.opts.writer.set(name, value);
    // Recorded only when the write actually happened. A refused value that still marked the
    // name configured would show a green tick beside a credential nothing has.
    if (written.ok) {
      await this.opts.refs?.markConfigured(_ctx, { name, provider: this.opts.providerFor?.(name) ?? null });
    }
    return written;
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
    // The run id is what a hosted store resolves a workspace from; here there is no workspace
    // to resolve to, so the usage is recorded in memory above and the table is left alone.
    // Writing every local workspace's row would be recording a fact the file cannot support.
    return out;
  }

  /**
   * The same values, for a platform-side call rather than for a run.
   *
   * Locally these are the same thing: `runtime/.env` has no notion of a workspace in it, so
   * both answer from the process environment. The two methods exist apart because on the hosted
   * store they resolve their scope differently — a run from its own id, a platform call from the
   * asking context — and a local store that collapsed them would make the call site
   * implementation-specific, which is the one thing an interface is for.
   */
  async getForPlatformCall(_ctx: TenantContext, names: string[]): Promise<Record<string, string>> {
    return this.getForRun("", names);
  }

  /**
   * What is configured, by name.
   *
   * Read back out of the file with the REAL parser rather than a regex, so what is reported as
   * configured is what the loaders would actually load — a line this store cannot parse is a
   * line a run would not receive either, and listing it would be a lie the user acts on.
   */
  async listNames(ctx: TenantContext): Promise<SecretRef[]> {
    // The registry first, when there is one: it is the answer every implementation gives, and
    // it knows things the file does not — what a name is for, and when a run last used it.
    if (this.opts.refs) {
      const rows = await this.opts.refs.list(ctx);
      return rows
        .filter((r) => r.configured)
        .map((r) => ({ name: r.name, configured: true as const, provider: r.provider, lastUsedAt: r.last_used_at }));
    }

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

  async delete(ctx: TenantContext, name: string): Promise<void> {
    assertSecretName(name);
    this.opts.writer.clear(name);
    this.lastUsed.delete(name);
    // Cleared, not forgotten. A name an agent still declares is still a name the user needs to
    // see — now with an empty state beside it rather than vanishing from the panel.
    await this.opts.refs?.markCleared(ctx, name);
  }
}
