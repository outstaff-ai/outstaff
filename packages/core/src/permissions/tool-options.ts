import type { z } from "zod";
import { CONFIG_CODES } from "../config/codes.js";
import { customIssue } from "../config/issues.js";
import type { ToolDeclaration } from "./types.js";

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasChecksum = (v: unknown) => typeof v === "string" && v.trim() !== "";

export function checkOptions(name: string, t: ToolDeclaration, ctx: z.RefinementCtx) {
  const { options, source } = t;
  if (options === undefined) {
    if (source?.startsWith("http:")) {
      ctx.addIssue(
        customIssue(
          CONFIG_CODES.toolsHttpChecksum,
          `Tool "${name}" has an http: source and needs options.checksum, or one per platform.`,
          [name, "options"],
        ),
      );
    }

    return;
  }

  if (source === undefined) {
    ctx.addIssue(
      customIssue(
        CONFIG_CODES.toolsOptionsWithoutSource,
        `Tool "${name}" sets options but no source; options go to the backend the source names.`,
        [name, "options"],
      ),
    );
  }

  if ("version" in options) {
    ctx.addIssue(
      customIssue(
        CONFIG_CODES.toolsReservedOption,
        `Tool "${name}" sets options.version; use the version field.`,
        [name, "options", "version"],
      ),
    );
  }

  if (!source?.startsWith("http:") || hasChecksum(options["checksum"])) {
    return;
  }

  const platforms = isMap(options["platforms"]) ? Object.entries(options["platforms"]) : [];
  const missing = platforms.filter(([, p]) => !isMap(p) || !hasChecksum(p["checksum"]));
  if (platforms.length === 0) {
    ctx.addIssue(
      customIssue(
        CONFIG_CODES.toolsHttpChecksum,
        `Tool "${name}" has an http: source and needs options.checksum, or one per platform.`,
        [name, "options", "checksum"],
      ),
    );
  }

  for (const [platform] of missing) {
    ctx.addIssue(
      customIssue(
        CONFIG_CODES.toolsHttpChecksum,
        `Platform "${platform}" of tool "${name}" has no checksum.`,
        [name, "options", "platforms", platform, "checksum"],
      ),
    );
  }
}
