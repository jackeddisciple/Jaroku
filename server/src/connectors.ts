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
