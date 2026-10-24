// Writes public/sponsors.svg (and .png) before the Astro build. With SPONSORKIT_GITHUB_TOKEN set it
// generates them from the Sponsors API; without it, local and fork builds get a placeholder, so
// they never fail and never need the token. A failure with a token fails the build. Generated files are not committed.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(docs, "public");
mkdirSync(out, { recursive: true });

const placeholder = () => {
  rmSync(path.join(out, "sponsors.png"), { force: true });
  copyFileSync(path.join(docs, "scripts/sponsors-placeholder.svg"), path.join(out, "sponsors.svg"));
  console.log("sponsors: wrote the placeholder");
};

if (process.env.SPONSORKIT_GITHUB_TOKEN) {
  // With a token, a failure must fail the build: a failed deploy keeps the last published site,
  // while a placeholder would quietly replace the real sponsors.
  try {
    execFileSync("pnpm", ["exec", "sponsorkit"], { cwd: docs, stdio: "inherit" });
  } catch (error) {
    console.error(`sponsors: generation failed: ${error.message}`);
    process.exit(1);
  }

  console.log("sponsors: generated from the Sponsors API");
} else {
  placeholder();
}
