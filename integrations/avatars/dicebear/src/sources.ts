import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PortError, type AdapterContext, type Avatars } from "@outstaff/core";
import type { DirectoryOptions, UrlOptions } from "./types.js";

const EXTENSIONS = [
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
] as const;

// A seed is a person handle; refuse anything that could leave the directory.
const SAFE_SEED = /^[\w][\w.-]*$/;

/** Reads `<seed>.png` or `<seed>.svg` from a directory. Images are served as they are (size is ignored). */
export function createDirectoryAvatars(options: DirectoryOptions): Avatars {
  const dir = resolve(options.path);
  return {
    async render(seed) {
      if (!SAFE_SEED.test(seed) || seed.includes("..")) {
        throw new PortError("invalid", `"${seed}" cannot be used as an avatar file name.`);
      }

      for (const [ext, mime] of EXTENSIONS) {
        try {
          return { data: new Uint8Array(await readFile(join(dir, `${seed}.${ext}`))), mime };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }

      throw new PortError("not_found", `No ${seed}.png or ${seed}.svg in ${dir}.`);
    },
  };
}

/** Downloads the image at the template URL, with `{seed}` replaced. Images are served as they are (size is ignored). */
export function createUrlAvatars(ctx: AdapterContext<UrlOptions>): Avatars {
  return {
    async render(seed) {
      const url = ctx.options.template.replace("{seed}", encodeURIComponent(seed));
      const res = await ctx.fetch(url);
      if (res.status === 404) {
        throw new PortError("not_found", `No avatar at ${url}.`);
      }

      if (!res.ok) {
        throw new PortError("unavailable", `Fetching ${url} failed: ${res.status}.`);
      }

      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const mime = type === "image/png" || type === "image/svg+xml" ? type : undefined;
      if (!mime) {
        throw new PortError("invalid", `${url} is ${type || "untyped"}, not a PNG or SVG.`);
      }

      return { data: new Uint8Array(await res.arrayBuffer()), mime };
    },
  };
}
