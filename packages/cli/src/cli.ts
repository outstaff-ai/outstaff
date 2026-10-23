#!/usr/bin/env node
import { readFileSync } from "node:fs";

const pkgUrl = new URL("../package.json", import.meta.url);
const { version } = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version: string };

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(version);
} else {
  console.log("Usage: outstaff [--version]");
}
