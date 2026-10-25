import { existsSync, readFileSync } from "node:fs";
import { globalConfigFile } from "./install.js";
import type { MiseRunner } from "./types.js";

/**
 * Answers `mise current <tool>` the way mise does: with the version the global config file sets, and nothing when
 * it sets none. Wraps a runner for everything else (tests only).
 */
export const withGlobalConfig =
  (inner: MiseRunner): MiseRunner =>
  async (args, opts) => {
    if (args[0] !== "current") {
      return inner(args, opts);
    }

    const file = globalConfigFile(opts.cwd, opts.env);
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const key = args[1]!.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const version = new RegExp(`^"${key}" = "([^"]+)"`, "m").exec(text)?.[1];
    return {
      code: 0,
      stdout: version ? `${version}\n` : "",
      stderr: version ? "" : "mise WARN no version set",
    };
  };
