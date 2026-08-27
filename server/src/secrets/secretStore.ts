// The secret boundary. Everything that is a credential goes through this interface, and the
// shape of the interface is the security property — not the implementations behind it.
//
// THERE IS NO `get(ctx, name)`, and there is now exactly one way to read a value back: see
// `revealForUser` below, and ADR-035, which supersedes the half of ADR-033 this paragraph used to
// state absolutely. The original rule was that NO method returns a plaintext value to a request
// handler; the rule today is narrower and worth stating precisely, because a half-remembered
// version of it is how the next widening gets argued for:
//
//   No method returns a plaintext value to a caller that has not proved a live, elevated session
//   for the workspace that owns it — and the proof is a value the type system will not let a
//   caller invent.
//
// Everything else is unchanged. Values still move in through `set`; they still reach a run's
// environment only through `getForRun` and a platform-side model call only through
// `getForPlatformCall`; and every other question a caller has — is it configured, what is it
// called, when was it last used — is still answered by `listNames`, which returns names and never
// a value. `revealForUser` is a fourth door with a lock on it, not an open wall.
//
// That is not a new rule. It is the rule `envWriter.ts` has followed since the day it was
// written ("callers learn that a key IS SET; they do not learn what is in it"), stated as a
// type instead of as a discipline. The difference matters hosted: locally the value was in a
// file the user owned, and the worst case of a leak was showing somebody their own key.
//
// `getForRun` TAKES A RUN ID, NOT A CONTEXT, and that is deliberate too. In Session 4 the
// caller is a worker assembling a sandbox spec, and the only identity it holds is the run's —
// a run outlives the request that started it, and by the time its environment is being built
// the asking context is long gone. So the run is the unit of authorisation for a secret, and
// which workspace it belongs to is resolved from the run rather than asserted by the caller.
//
// TWO IMPLEMENTATIONS, ALWAYS. `DotEnvSecretStore` wraps `envWriter.ts` unchanged and keeps
// `runtime/.env` working exactly as it does today, so `npm run dev` needs no KMS, no cloud
// account and no key material. `KmsSecretStore` is production. Selected by config.

import type { TenantContext } from "../db/tenant.ts";
import type { ElevationReceipt } from "./elevation.ts";

export type SecretStoreKind = "dotenv" | "kms";

/** What a caller may know about a secret. Never a value, on any implementation, ever. */
export interface SecretRef {
  /** The environment variable name a run will see it under. */
  name: string;
  /**
   * Always true for anything this returns.
   *
   * Present as a field rather than implied by presence in the list, because that is what the
   * client renders and what the README promises it learns: `configured: true` and nothing
   * more. A shape that says so is harder to widen by accident than a bare array of strings.
   */
  configured: true;
  /** `anthropic`, `openai`, `mcp`, `railway`, `connector` — what it is for, when known. */
  provider: string | null;
  /** ISO-8601. When a run last received this value, or null if it never has. */
  lastUsedAt: string | null;
}

/** What `set` reports back. A warning is not a failure; a refusal is. */
export interface SetResult {
  ok: boolean;
  /**
   * Something the user needs to know, or null.
   *
   * The local store's is load-bearing: a variable already exported in the developer's shell
   * beats the file on the next restart, so a token written here works now and silently reverts
   * later. That is a genuinely baffling bug to hit, and saying so is the fix.
   */
  warning: string | null;
}

export interface SecretStore {
  readonly kind: SecretStoreKind;

  /**
   * Store `value` under `name` for this workspace.
   *
   * The value is used here and nowhere else: not logged, not returned, not held in any
   * structure that outlives the call. A value that cannot be stored FAITHFULLY is refused
   * rather than mangled — see envWriter.ts for why a silently altered credential is worse than
   * a rejected one.
   */
  set(ctx: TenantContext, name: string, value: string): Promise<SetResult>;

  /**
   * The values a run's environment needs, by name.
   *
   * The only method that returns plaintext, and its caller is the thing that builds a run's
   * environment. Names not configured are simply absent from the result — a missing credential
   * is the agent's problem to report at the point of use, and inventing an empty string for one
   * turns a clear "not configured" into an opaque 401 from a third party.
   */
  getForRun(runId: string, names: string[]): Promise<Record<string, string>>;

  /**
   * The values a PLATFORM-SIDE model call needs, for a workspace that asked us to use its own.
   *
   * THE SECOND AND LAST PLAINTEXT EXIT, and adding it was a decision rather than an oversight,
   * so here is the reasoning in full.
   *
   * The rule at the top of this file is that no method returns a plaintext value TO A REQUEST
   * HANDLER — that is what closes the path down which a credential reaches a WebSocket frame, a
   * log line or a JSON response. `getForRun` is not an exception to that rule; it is a value
   * flowing INTO an execution and never back out. This is the same shape: generation, the plan
   * gate, the fix loop, explain and the judge are model calls the platform makes on a
   * workspace's behalf, and a workspace that has opted its own key in is asking for its
   * credential to go into those calls exactly as it already goes into its runs.
   *
   * It could have been expressed as `getForRun` against a synthetic run id, and that would have
   * been worse in two specific ways: the hosted store resolves a workspace FROM the run id, so a
   * made-up one resolves to nothing and the feature would silently not work; and `last_used_at`
   * would be attributed to a run that does not exist. A method that says what it is for is
   * cheaper to audit than a real method being used dishonestly.
   *
   * What it is NOT: a general `get`. It takes a list of names and returns a map, it is never
   * called by anything that serialises its result, and — like `getForRun` — a name that is not
   * configured is simply absent rather than an empty string.
   */
  getForPlatformCall(ctx: TenantContext, names: string[]): Promise<Record<string, string>>;

  /**
   * The bearer token for one deployed agent's own endpoint, for the dispatcher that calls it.
   *
   * THE FOURTH DOOR, AND IT IS THE NARROWEST ONE ON THIS INTERFACE. It exists because the deploy
   * layer reversed a property it used to hold out loud — "Jaroku does not keep a copy" — and a
   * reversal is worth making visible rather than smuggling through a method that already exists.
   *
   * WHY NOT ONE OF THE THREE ALREADY HERE, since the honest answer to "can something existing
   * carry this" is what §8 asks for before it is built:
   *
   *   `getForRun` takes a RUN ID and resolves the workspace from it. The dispatcher is holding a
   *   deployment, and the run it is about to start does not exist yet — that is the point of the
   *   call. A synthetic run id would resolve to nothing on the hosted store and would attribute
   *   `last_used_at` to a run nobody could find, which is exactly the dishonest reuse the
   *   `getForPlatformCall` note already rejected once.
   *
   *   `getForPlatformCall` is for a model call the platform makes on a workspace's behalf. This is
   *   not a model call and not the platform's spend; widening that method's meaning to fit would
   *   make its own careful docstring false.
   *
   *   `revealForUser` hands a value to the PERSON who owns it, behind a live elevation. Nobody is
   *   present here — this is a dispatcher on a background path — and requiring elevation would
   *   mean a scheduled job could never run a deployed agent.
   *
   * WHAT KEEPS IT NARROW. It takes a SERVICE ID, not a name: the store derives the name itself
   * through `serveTokenEnvKeyFor`, so this door cannot be asked for an arbitrary credential the
   * way a `get(ctx, name)` could. It returns ONE value, never a map. And like `getForRun`, it is
   * a value flowing INTO an outbound call — an Authorization header on a request to the user's
   * own container — and never back out to a request handler.
   *
   * Null means there is no stored token, which is a real and common state rather than an error:
   * every agent deployed before this existed has one, and it is what the reconnect flow is for.
   */
  getServeToken(ctx: TenantContext, serviceId: string): Promise<string | null>;

  /**
   * Store a deployment's own bearer token. The write half of the door above.
   *
   * A SEPARATE METHOD RATHER THAN `set(ctx, serveTokenEnvKeyFor(id), token)`, and the reason is
   * `listNames`. A serve token is Jaroku's own plumbing, not a credential a user typed: they
   * never set it, they cannot usefully edit it, and rotating it is a button rather than a paste.
   * The local store already knows that — its `NOT_A_SECRET` filter hides every `JAROKU_*` name
   * that is not an MCP token, for exactly this reason — and the hosted store lists from the
   * name registry, which the generic `set` writes to unconditionally. So the generic path made
   * the two implementations DISAGREE about whether a workspace with three deployments has three
   * credentials: invisible locally, three rows of `JAROKU_DEPLOY_<uuid>_SERVE_TOKEN` in
   * production, burying the keys the panel exists for.
   *
   * Pairing the write with the read fixes that in one place and keeps the name derivation
   * entirely inside the store, which is what stops a caller reaching a different secret through
   * either half.
   */
  setServeToken(ctx: TenantContext, serviceId: string, token: string): Promise<SetResult>;

  /**
   * Hand a stored value back to the person who owns it.
   *
   * THE THIRD PLAINTEXT EXIT, AND THE ONE THAT REVERSES THE RULE AT THE TOP OF THIS FILE. It is
   * recorded in ADR-035, which supersedes the relevant half of ADR-033, and the honest summary is:
   * the product decided a user must be able to read their own credential back, and that is a
   * decision this interface now expresses instead of forbidding. Pretending otherwise by hiding it
   * behind a differently-named method would be worse than saying so here.
   *
   * WHAT IS LEFT OF THE ORIGINAL GUARANTEE, because it is not nothing:
   *
   *   IT CANNOT BE REACHED FROM A REQUEST HANDLER THAT HAS NOT PROVED ELEVATION. The first
   *   argument is an `ElevationReceipt`, whose brand is a symbol `secrets/elevation.ts` does not
   *   export. There is no way to construct one, cast to one from a request body, or obtain one
   *   except by calling `SecretElevations.receiptFor` and having it say yes. ADR-033's argument
   *   was that a compile-time absence beats a runtime check; this is the strongest compile-time
   *   thing still available once the method has to exist.
   *
   *   IT TAKES THE RECEIPT INSTEAD OF A CONTEXT, exactly as `getForRun` takes a run id. The
   *   workspace is read OFF the receipt rather than asserted by the caller, so a caller cannot
   *   name a workspace it was not elevated in — the same reasoning, applied to a different proof.
   *
   *   IT IS ONE NAME, NOT A LIST. `getForRun` takes an array because a run needs an environment.
   *   Nothing legitimate needs to read every credential a workspace has at once, and a signature
   *   that cannot express it is one nobody will accidentally write.
   *
   * A name that is not configured returns null rather than an empty string, for the same reason it
   * is absent from `getForRun`: a missing credential is a fact, and inventing "" for one turns it
   * into an opaque failure somewhere else.
   */
  revealForUser(receipt: ElevationReceipt, name: string): Promise<string | null>;

  /** What this workspace has configured. Names only. */
  listNames(ctx: TenantContext): Promise<SecretRef[]>;

  /** Forget one. Idempotent: deleting what is not there is not an error. */
  delete(ctx: TenantContext, name: string): Promise<void>;
}

/**
 * The gate a secret NAME passes through.
 *
 * A name becomes an environment variable in a subprocess and, in the hosted store, part of a
 * primary key. `MCP_TOKEN=x; rm -rf /` is not a variable name, and neither is one with an equals
 * sign or a newline in it — the `.env` format has no escape for either, which is the same
 * reason envWriter refuses a value containing one.
 */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

export function isSecretName(name: unknown): name is string {
  return typeof name === "string" && SECRET_NAME.test(name);
}

export function assertSecretName(name: unknown): string {
  if (!isSecretName(name)) {
    throw new Error(
      `not a usable credential name: ${JSON.stringify(name)} — it must be UPPER_SNAKE_CASE, ` +
        `start with a letter, and be at most 128 characters`,
    );
  }
  return name;
}

/**
 * Why a value cannot be stored, or null when it can.
 *
 * ONE RULE FOR BOTH IMPLEMENTATIONS, which is why it lives here rather than in either of them.
 * AES-GCM would happily seal a value containing a newline and the `.env` format cannot hold
 * one — so a hosted store that accepted it would produce a credential that works in production
 * and fails locally, and an exported project (which the README promises is portable, and which
 * writes a `.env`) would silently lose it.
 *
 * The local store applies a SECOND, narrower rule on top of this: `envWriter.renderLine`
 * refuses anything that would not read back byte-identically through the real loader. That one
 * is a property of the file format and cannot be shared.
 */
export function unstorableReason(value: unknown): string | null {
  if (typeof value !== "string") return "a credential must be a string";
  if (/[\r\n]/.test(value)) {
    // Refusing rather than stripping: a value with a line break in it is not the value the user
    // meant to paste, and silently truncating a credential produces a confusing 401 instead of
    // a clear error. Same judgement, same words, as envWriter.
    return "a credential cannot contain a line break";
  }
  if (value.includes("\u0000")) {
    // Postgres cannot store one in a text column at all — the driver fails the whole statement.
    // Refusing here makes the two drivers agree instead of one of them losing the write.
    return "a credential cannot contain a NUL byte";
  }
  return null;
}

/**
 * Which workspace a run belongs to.
 *
 * Injected into a store rather than looked up by it, so the secrets layer does not grow a
 * dependency on the trace store — and so the test for a store can hand it a map. Returning null
 * means "no such run", which every implementation must treat as "no secrets", never as "all of
 * them".
 */
export type RunWorkspaceResolver = (runId: string) => Promise<string | null>;
