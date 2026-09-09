// The three tiers as they exist in ../web/pricing.html and in the brief. Any drift here is
// a bug; the copy is written once and consumed by /pricing, /teams and the home closer.
export type CTAKind = "download" | "contact";

export interface Tier {
  key: "free" | "pro" | "team";
  name: string;
  price: string;
  cadence?: string;
  tag: string;
  line: string;
  cta: { label: string; kind: CTAKind };
  featured?: boolean;
  bullets: string[];
}

export const TIERS: Tier[] = [
  {
    key: "free",
    name: "Free",
    price: "$0",
    tag: "Bring your own key",
    line: "Bring your own provider key. No inference runs through us.",
    cta: { label: "Download", kind: "download" },
    bullets: [
      "1 workspace",
      "3 agents",
      "500 runs a month",
      "7 days of trace history",
      "Your own provider key",
    ],
  },
  {
    key: "pro",
    name: "Pro",
    price: "$20",
    cadence: "/month",
    tag: "For a single operator",
    line: "Single operator, with $15 of inference included.",
    cta: { label: "Download", kind: "download" },
    featured: true,
    bullets: [
      "3 workspaces",
      "Unlimited agents",
      "10,000 runs a month",
      "90 days of trace history",
      "GitHub push",
      "$15 of inference included",
    ],
  },
  {
    key: "team",
    name: "Team",
    price: "$40",
    cadence: "/user/month",
    tag: "Two people or more",
    line: "Two people or more, with $30 of inference each, pooled.",
    cta: { label: "Contact", kind: "contact" },
    bullets: [
      "Unlimited workspaces",
      "Up to 20 members",
      "50,000 runs a month, pooled",
      "A year of trace history",
      "GitHub sync, Access grants, Policy",
      "$30 of inference each, pooled",
    ],
  },
];

// Comparison rows. Grouped as the existing table does, kept 1:1 with the file it replaces so
// nobody arrives at the new page with a claim that has quietly changed underneath them.
export interface MatrixGroup {
  title: string;
  rows: [string, string, string, string][]; // [label, free, pro, team]
}

export const MATRIX: MatrixGroup[] = [
  {
    title: "Scale",
    rows: [
      ["Workspaces per user", "1", "3", "Unlimited"],
      ["Members per workspace", "1", "1", "Up to 20"],
      ["Agents per workspace", "3", "Unlimited", "Unlimited"],
      ["Concurrent live deployments", "1", "5", "Unlimited"],
      ["Runs per month", "500", "10,000", "50,000 pooled"],
      ["Eval runs per month", "20", "500", "2,500 pooled"],
      ["Connected MCP servers", "3", "Unlimited", "Unlimited"],
    ],
  },
  {
    title: "History",
    rows: [
      ["Trace retention", "7 days", "90 days", "365 days"],
      ["Audit log retention", "7 days", "90 days", "365 days"],
      ["Version history", "Full", "Full", "Full"],
    ],
  },
  {
    title: "Inference",
    rows: [
      ["Your own provider key", "Required", "Optional", "Optional"],
      ["Included credit", "—", "$15/month", "$30/user/month"],
      ["Overage", "—", "At cost + 15%", "At cost + 15%, pooled"],
    ],
  },
  {
    title: "Features",
    rows: [
      ["GitHub push", "—", "Yes", "Yes"],
      ["GitHub sync (bidirectional)", "—", "—", "Yes"],
      ["Per-agent Access grants", "—", "—", "Yes"],
    ],
  },
  {
    title: "Support",
    rows: [
      ["Channel", "GitHub Issues", "Email, 48h", "Priority email, 24h"],
    ],
  },
];
