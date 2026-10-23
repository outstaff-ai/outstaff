import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLinksValidator from "starlight-links-validator";

export default defineConfig({
  site: "https://docs.outstaff.work",
  integrations: [
    starlight({
      title: "Outstaff",
      logo: { light: "./src/assets/brand/logo.svg", dark: "./src/assets/brand/logo-dark.svg", replacesTitle: true, alt: "outstaff" },
      favicon: "/favicon.svg",
      description: "Run a team of AI agents like an outsourcing agency.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/outstaff-ai/outstaff" }],
      plugins: [starlightLinksValidator()],
      sidebar: [
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        { label: "Architecture", items: [{ autogenerate: { directory: "architecture" } }] },
        { label: "Getting started", items: [{ autogenerate: { directory: "getting-started" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Adapters", items: [{ autogenerate: { directory: "adapters" } }] },
        { label: "Decisions", items: [{ autogenerate: { directory: "decisions" } }] },
      ],
    }),
  ],
});
