// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";

// The public site would live at jaroku.dev. That domain is not owned yet, so the local
// dev server is the source of truth for this pass. `site` is set to the local origin so
// generated URLs (sitemap, canonical) resolve during preview; swap when the domain lands.
export default defineConfig({
  site: "http://localhost:4321",
  trailingSlash: "never",
  build: {
    format: "directory",
    assets: "_assets",
  },
  integrations: [mdx(), sitemap()],
  vite: {
    ssr: {
      noExternal: ["three"],
    },
  },
});
