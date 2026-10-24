import { defineConfig, tierPresets } from "sponsorkit";

// The token comes from SPONSORKIT_GITHUB_TOKEN; it is never written here.
export default defineConfig({
  github: { login: "outstaff-ai", type: "organization" },
  width: 800,
  formats: ["svg", "png"],
  outputDir: "public",
  cacheFile: "node_modules/.cache/sponsorkit/cache.json",
  includePastSponsors: true,
  // Lowest tier first. Each tier starts at its monthly amount; -1 is past sponsors.
  tiers: [
    { title: "Past sponsors", monthlyDollars: -1, preset: tierPresets.xs },
    { title: "Supporters", monthlyDollars: 5, preset: tierPresets.xs },
    { title: "Backers", monthlyDollars: 25, preset: tierPresets.small },
    { title: "Bronze sponsors", monthlyDollars: 100, preset: tierPresets.base },
    { title: "Silver sponsors", monthlyDollars: 500, preset: tierPresets.large },
    { title: "Gold sponsors", monthlyDollars: 1500, preset: tierPresets.xl },
  ],
});
