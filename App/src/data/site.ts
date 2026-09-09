// Site-wide constants. Kept as literals so a fact appearing on two pages cannot drift.
export const SITE = {
  name: "Jaroku",
  version: "0.3.11",
  tagline: "Build, deploy and operate LangGraph agents you can copy out and run anywhere.",
  domain: "jaroku.dev",
  contactEmail: "contact@jaroku.dev",
  // From SECURITY.md — the address the repo publishes for vulnerability reports.
  securityEmail: "adarshhchoudhary1@gmail.com",
  // From SECURITY.md — the GitHub repo the advisories link points at.
  github: "https://github.com/jackeddisciple/jaroku",
  githubAdvisories: "https://github.com/jackeddisciple/jaroku/security/advisories/new",
  x: "https://x.com/jaroku",
  // The deep-link scheme is registered in src-tauri/tauri.conf.json.
  deepLinkScheme: "jaroku",
  // Version currency: legal pages carry a "current as of" date. Update at publish.
  legalAsOf: "2 September 2026",
} as const;

export const PRIMARY_NAV = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About" },
  { href: "/pricing", label: "Pricing" },
  { href: "/teams", label: "Teams" },
] as const;

export const RESOURCES_NAV = [
  { href: "/models", label: "Models", description: "Which providers and models work today." },
  { href: "/changelog", label: "Changelog", description: `Every release, newest first — currently v${SITE.version}.` },
  { href: "/download", label: "Download", description: "macOS, Windows and Linux builds." },
  { href: "/docs", label: "Docs", description: "The manual for the desktop app." },
  { href: "/learn", label: "Learn", description: "Guides — agents, traces, deployment." },
  { href: "/help", label: "Help", description: "FAQ and the routes for reaching a human." },
] as const;

export const LEGAL_NAV = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/security", label: "Security" },
] as const;
