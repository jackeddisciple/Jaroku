// Parse the repository's CHANGELOG.md into entries. Kept read-only and structural: sections
// under a version heading (Added, Fixed, Deprecated, Not in this release, deliberately, etc.)
// are collected as-is, with paragraph and list splitting left to render time. The file is
// large — ~4k lines at v0.3.11 — so the /changelog page paginates rather than shipping it
// all in one document. Parsing runs at build time via Node fs, so nothing ships to the
// browser.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = path.resolve(dir, "../../../CHANGELOG.md");

export interface Section {
  title: string;
  // rendered as markdown-ish; we keep raw lines and let the renderer split
  lines: string[];
}

export interface Release {
  version: string;   // "0.3.11"
  slug: string;      // "0-3-11"
  title: string;     // "Talking To An Agent — The Per-Agent Conversation, On The Record"
  headline: string;  // first paragraph after the heading
  sections: Section[];
  raw: string;
}

function slugify(version: string): string {
  return version.replace(/[^0-9a-z]+/gi, "-").toLowerCase();
}

let cached: Release[] | null = null;

export function loadReleases(): Release[] {
  if (cached) return cached;

  const source = fs.readFileSync(CHANGELOG_PATH, "utf8");
  const lines = source.split("\n");

  // Version headings look like:  ## v0.3.11 : Talking To An Agent — …
  const releases: Release[] = [];
  let current: Release | null = null;
  let currentSection: Section | null = null;
  let firstParagraphBuf: string[] | null = null;

  const closeSection = () => {
    if (current && currentSection && currentSection.lines.some((l) => l.trim().length > 0)) {
      current.sections.push(currentSection);
    }
    currentSection = null;
  };

  const closeRelease = () => {
    if (!current) return;
    closeSection();
    if (firstParagraphBuf) {
      current.headline = firstParagraphBuf.join(" ").replace(/\s+/g, " ").trim();
      firstParagraphBuf = null;
    }
    releases.push(current);
    current = null;
  };

  for (const line of lines) {
    const versionMatch = /^##\s+v(\d+\.\d+\.\d+)\s*(?::\s*(.+))?$/.exec(line);
    if (versionMatch) {
      closeRelease();
      const version = versionMatch[1];
      current = {
        version,
        slug: slugify(version),
        title: (versionMatch[2] ?? "").trim(),
        headline: "",
        sections: [],
        raw: "",
      };
      firstParagraphBuf = [];
      currentSection = { title: "Overview", lines: [] };
      continue;
    }

    if (!current) continue;

    const sectionMatch = /^###\s+(.+)$/.exec(line);
    if (sectionMatch) {
      // The first paragraph after the version heading ends when we hit the first ### or a
      // blank followed by another ###/---/##.
      if (firstParagraphBuf && firstParagraphBuf.length) {
        current.headline = firstParagraphBuf.join(" ").replace(/\s+/g, " ").trim();
        firstParagraphBuf = null;
      }
      closeSection();
      currentSection = { title: sectionMatch[1].trim(), lines: [] };
      continue;
    }

    if (/^---\s*$/.test(line)) {
      closeRelease();
      continue;
    }

    if (firstParagraphBuf) {
      if (line.trim().length === 0 && firstParagraphBuf.length > 0) {
        current.headline = firstParagraphBuf.join(" ").replace(/\s+/g, " ").trim();
        firstParagraphBuf = null;
        continue;
      }
      if (line.trim().length > 0 && current.sections.length === 0) {
        firstParagraphBuf.push(line);
      }
    }

    if (currentSection) currentSection.lines.push(line);
    current.raw += line + "\n";
  }

  closeRelease();

  // Newest first. The file is already newest-first, but sort defensively.
  releases.sort((a, b) => {
    const pa = a.version.split(".").map(Number);
    const pb = b.version.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pb[i] - pa[i];
    }
    return 0;
  });

  cached = releases;
  return releases;
}

// Very small markdown-ish renderer for a section's lines. We don't need a full markdown
// engine — the changelog uses a narrow subset: bullets, emphasis, code, and links.
export function renderSection(lines: string[]): string {
  const html: string[] = [];
  const buf: string[] = [];
  let listOpen = false;

  const flushParagraph = () => {
    const text = buf.join(" ").trim();
    buf.length = 0;
    if (!text) return;
    html.push(`<p>${inline(text)}</p>`);
  };

  const openList = () => {
    if (!listOpen) { html.push('<ul class="cl-list">'); listOpen = true; }
  };
  const closeList = () => {
    if (listOpen) { html.push("</ul>"); listOpen = false; }
  };

  for (let raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const isBullet = /^\s*[-*]\s+/.test(line);
    const isBlank = line.trim().length === 0;

    if (isBullet) {
      flushParagraph();
      openList();
      const content = line.replace(/^\s*[-*]\s+/, "");
      html.push(`<li>${inline(content)}</li>`);
      continue;
    }

    if (isBlank) {
      flushParagraph();
      closeList();
      continue;
    }

    if (listOpen) {
      // Wrapped continuation of the last <li>.
      const last = html.length - 1;
      if (html[last].startsWith("<li>")) {
        html[last] = html[last].replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
        continue;
      }
    }

    buf.push(line.trim());
  }
  flushParagraph();
  closeList();

  return html.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inline(text: string): string {
  let out = escapeHtml(text);
  // Code — greedy backtick pairs (the changelog has plenty).
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code class="mono">${code}</code>`);
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic (single underscore or star, not touching bold pairs)
  out = out.replace(/(^|[^\*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // Links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const safe = /^(https?:|mailto:|\/)/i.test(href) ? href : "#";
    return `<a href="${safe}" rel="noopener">${label}</a>`;
  });
  return out;
}

// Naive month/year inference: version bumps aren't dated in the file except in the release
// summary prose. We surface the version number only and don't fabricate a date.
export function pageRelease(release: Release): { headline: string; sections: { title: string; html: string; }[] } {
  return {
    headline: inline(release.headline),
    sections: release.sections.map((s) => ({ title: s.title, html: renderSection(s.lines) })),
  };
}

export function paginate<T>(items: T[], pageSize: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += pageSize) {
    pages.push(items.slice(i, i + pageSize));
  }
  return pages;
}
