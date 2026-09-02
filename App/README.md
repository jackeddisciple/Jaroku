# Jaroku — Landing Site

The public marketing site for Jaroku, a desktop application for building, deploying and
operating LangGraph agents.

## Why this stack

**Astro (static output).** A marketing site has no runtime state and shouldn't need one.
Astro renders every page to HTML at build time and ships zero JavaScript by default, so
text is on the screen before Three.js loads — a hard requirement in the brief. Any
interactive piece is a client island loaded only where it appears, so the changelog page
doesn't drag the hero shader along with it. MDX handles the changelog and docs prose
without inventing a CMS. The sitemap integration writes `/sitemap-index.xml` from the
route table.

**Three.js loaded lazily.** The hero scene lives in `src/lib/hero-scene.ts`, mounted by
a small entry that only imports Three when the canvas is on screen. Reduced-motion,
tab-visibility and WebGL absence are handled at mount rather than as an afterthought.

**HugeIcons, inlined.** The free set, checked in as inline SVG under
`src/components/icons/`. No runtime font, no hotlink.

## Running

```bash
cd App
npm install       # or: bun install
npm run dev       # http://127.0.0.1:4321
npm run build     # dist/
npm run preview   # serves dist/ on the same port
```

Node 20.3+ is required.

## Layout

```
App/
├─ src/
│  ├─ pages/            # one file per public route
│  ├─ layouts/          # Base wraps every page
│  ├─ components/       # Header, Footer, Card, Icon, etc.
│  ├─ lib/              # Three.js scene, changelog parser
│  ├─ styles/           # tokens.css, globals.css
│  ├─ data/             # models.ts (pricing.json), tiers.ts
│  └─ content/          # changelog & docs MDX
├─ public/              # favicon, screenshots, static assets
└─ scripts/             # build helpers
```

## Ground truth

Every claim on the site comes from the repository:

- **Pricing** — the three tiers, prices, limits, and CTA policy live in `src/data/tiers.ts`
  and match `../web/pricing.html` / the brief.
- **Models** — read from `../runtime/pricing.json` at build via `src/data/models.ts`.
- **Changelog** — parsed from `../CHANGELOG.md`; newest first, paginated.
- **Security** — the wording and contact address come from `../SECURITY.md`.
- **App identifier, deep-link scheme, targets** — `../src-tauri/tauri.conf.json`.
- **Version** — `0.3.11`, from `../src-tauri/tauri.conf.json` and the changelog head.

## Download buttons are inert this pass

Real installer URLs do not exist yet. The macOS / Windows / Linux buttons are styled as
if live and route to `#` with a `data-placeholder="true"` attribute plus a code comment
so the state is visible to anybody who greps for it before the CDN is set up.

## Domain is not owned yet

`jaroku.dev` is aspirational. Every internal link is root-relative so the site works
identically on `http://localhost:4321`. `astro.config.mjs`'s `site` is set to the local
origin; swap it when the domain lands. Nothing on the site links to `jaroku.dev` as a
live destination.

## What is *not* built here

- No analytics.
- No newsletter form, no signup form, no email capture of any kind.
- No Stripe / checkout — every CTA downloads the app. Team's CTA is a `mailto:` to
  `contact@jaroku.dev`. This mirrors what `../web/README.md` states about why the app is
  the only checkout entry point.
