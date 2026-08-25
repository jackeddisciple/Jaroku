// Connector registry — reads runtime/tool_templates/catalog.json, the single source of
// truth for which reviewed connectors exist, what env they need, and what signatures the
// builder model is shown.
//
// The templates themselves are never parsed here: they are copied byte-for-byte into
// generated projects (see generator.ts). This module only supplies metadata.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ConnectorTool {
  name: string;
  signature: string;
  summary: string;
}

/**
 * How a workspace supplies this connector's credential.
 *
 * A field rather than a lookup keyed on the connector id, for the same reason `required_env` is
 * one: the catalog is where a connector is described, and a second table saying "gmail is OAuth"
 * is a second place to forget when a fourth connector arrives.
 *
 *   `oauth`        Jaroku owns the OAuth app and the user grants it access by clicking Connect.
 *                  What reaches a run is a short-lived access token the control plane minted.
 *                  `required_env` STILL lists the hand-configured names, and that is not a
 *                  contradiction — an exported project has no Jaroku to ask, and the README's
 *                  promise that it runs standalone depends on those names being documented.
 *   `user_secret`  The user supplies the value, and it goes into the vault under exactly the
 *                  names in `required_env`.
 *   `none`         No credential at all.
 */
export type ConnectorAuth = "oauth" | "user_secret" | "none";

export function isConnectorAuth(v: unknown): v is ConnectorAuth {
  return v === "oauth" || v === "user_secret" || v === "none";
}

export interface Connector {
  id: string;
  label: string;
  file: string;
  module: string;
  description: string;
  required_env: string[];
  /**
   * Names this connector READS but does not need, and which a user may therefore be offered.
   *
   * `required_env` is what nothing works without. This is the second door — the HTTP connector's
   * optional default auth header — and it is a catalog field rather than a table beside one for
   * the reason `auth` is: a second place to say "http also reads this" is a second place to forget
   * it, and forgetting it here has a specific, silent shape. A name offered in the Connections tab
   * and absent from a run's environment means the user pastes a value, the vault stores it, the
   * panel reports it configured, and every request goes out unauthenticated.
   *
   * NOT the OAuth access-token names. Those are read from the connector's own spec
   * (`accessSecretName`) and injected by `connectorRunEnv`, and listing them here as well would be
   * that same second place. `check_catalog()` holds this list to a subset of the module's own
   * `OPTIONAL_ENV`, so the catalog can never offer a name the template does not read.
   */
  optional_env?: string[];
  /** See ConnectorAuth. Absent in a catalog written before this existed, which reads as
   *  `user_secret` — the behaviour every connector had then, so an old catalog is unchanged. */
  auth?: ConnectorAuth;
  /** PyPI requirements this connector's template lazy-imports. What a deployed image installs. */
  pip_requires?: string[];
  tools: ConnectorTool[];
}

export function templatesDir(runtimeDir: string): string {
  return join(runtimeDir, "tool_templates");
}

export function loadConnectors(runtimeDir: string): Connector[] {
  const path = join(templatesDir(runtimeDir), "catalog.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { connectors: Connector[] };
  return parsed.connectors ?? [];
}

/** Only ids that actually exist in the catalog — never trust the client's list verbatim. */
export function resolveSelected(all: Connector[], requested: string[] | undefined): Connector[] {
  const wanted = new Set(requested ?? []);
  return all.filter((c) => wanted.has(c.id));
}

/** Union of env keys the selected connectors need, in catalog order, de-duplicated. */
export function requiredEnv(selected: Connector[]): string[] {
  const seen: string[] = [];
  for (const c of selected) {
    for (const key of c.required_env) if (!seen.includes(key)) seen.push(key);
  }
  return seen;
}

/**
 * How this connector is credentialed, defaulting to what every connector did before the field
 * existed. A catalog with no `auth` anywhere behaves exactly as it did.
 */
export function authModeOf(connector: Connector): ConnectorAuth {
  return isConnectorAuth(connector.auth) ? connector.auth : "user_secret";
}

/**
 * The env keys a user is expected to fill in THEMSELVES, out of a set of connectors.
 *
 * The distinction `.env.example` needs now that it did not before. A `user_secret` connector's
 * keys are a to-do list: nothing works until somebody pastes a value. An `oauth` connector's keys
 * are documentation for the standalone case — hosted, they are filled by a connection, and a
 * generated project that presented `GMAIL_REFRESH_TOKEN=` as a blank to fill in would be telling
 * a user to go and do by hand the thing the Connect button exists to do for them.
 */
export function userSuppliedEnv(selected: Connector[]): string[] {
  return requiredEnv(selected.filter((c) => authModeOf(c) === "user_secret"));
}

/** The mirror: keys a connection fills in, which the file documents rather than demands. */
export function connectionSuppliedEnv(selected: Connector[]): string[] {
  return requiredEnv(selected.filter((c) => authModeOf(c) === "oauth"));
}

/**
 * Union of the OPTIONAL env keys the selected connectors read, in catalog order, de-duplicated.
 *
 * Kept separate from `requiredEnv` rather than folded into it, because the two are read by callers
 * that must treat them differently. `required_env` is what a deploy REFUSES over when it is
 * missing — an unconfigured template raises on every call, so that container deploys green and is
 * dead — and an optional name in that list would refuse a deploy over a value nobody needs. What
 * both callers agree on is narrower and is the whole point of this function: a run resolves both,
 * because a name the panel offers and the sandbox never sees is a credential stored under a name
 * the runtime does not read.
 */
export function optionalEnv(selected: Connector[]): string[] {
  const seen: string[] = [];
  for (const c of selected) {
    for (const key of c.optional_env ?? []) if (!seen.includes(key)) seen.push(key);
  }
  return seen;
}

/** One `user_secret` connector this workspace has begun setting up, and what it still lacks. */
export interface ConfiguredConnector {
  connector: Connector;
  /** Required names with no value yet. Empty means it is ready to use. */
  missing: string[];
}

/**
 * Which `user_secret` connectors a workspace counts as HAVING, and what each still needs.
 *
 * THE COMPOSER DECK'S PRESENCE RULE, as a function rather than as a closure in `index.ts`, because
 * it is a rule with a wrong answer that looks right. The wrong answer shipped: the deck asked
 * "does it have a live OAuth connection", which hid every `user_secret` connector — one of three
 * when it was written, three of six now. A workspace with a working Stripe key saw no Stripe tile,
 * and the per-conversation toggle had nothing to toggle, so §12.10's promise that disabling a
 * connector removes its tools from that conversation's dispatch could not be kept for any of them.
 *
 * PRESENT WHEN ANY DECLARED NAME HAS A VALUE; MISSING LISTS ONLY THE REQUIRED ONES. Those are two
 * different questions and the first version of this asked one of them twice — it counted required
 * names for both, which meant a connector declaring exactly ONE required name had no half-set-up
 * state at all. `http` declares one, so somebody who pasted an auth header and had not yet typed
 * the allowlist saw the tile vanish rather than a tile saying what it needed. The end-to-end suite
 * is what caught it: the rule reads correctly and is wrong for the catalog it actually has.
 *
 * The direction it errs in mirrors the OAuth branch, where a connection needing reauthorising still
 * appears — carrying a warning — rather than vanishing. Anything stored is evidence this workspace
 * has begun; a connector with NOTHING stored has never been set up, which is an option rather than
 * a capability, and it stays absent or the deck becomes a picture of the product.
 *
 * `isConfigured` is asked per NAME rather than handed a store, so this stays pure and so the caller
 * keeps deciding what "configured" means — which for the one caller is the secret registry's own
 * flag, a fact about the vault that never involves reading a value.
 */
export function configuredUserSecretConnectors(
  all: Connector[],
  isConfigured: (name: string) => boolean,
): ConfiguredConnector[] {
  const out: ConfiguredConnector[] = [];
  for (const connector of all) {
    if (authModeOf(connector) !== "user_secret") continue;
    const declared = [...connector.required_env, ...(connector.optional_env ?? [])];
    // Nothing stored under any name it declares is "never set up", and absent is the right answer.
    if (!declared.some((name) => isConfigured(name))) continue;
    out.push({ connector, missing: connector.required_env.filter((name) => !isConfigured(name)) });
  }
  return out;
}

/**
 * Union of PyPI requirements the selected connectors need, in catalog order, de-duplicated.
 * Mirror of `tool_templates.pip_requires` — one field, two readers, same as required_env.
 */
export function pipRequires(selected: Connector[]): string[] {
  const seen: string[] = [];
  for (const c of selected) {
    for (const req of c.pip_requires ?? []) if (!seen.includes(req)) seen.push(req);
  }
  return seen;
}
