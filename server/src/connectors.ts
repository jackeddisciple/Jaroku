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

export interface Connector {
  id: string;
  label: string;
  file: string;
  module: string;
  description: string;
  required_env: string[];
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
