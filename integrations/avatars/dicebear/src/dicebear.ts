import { createAvatar } from "@dicebear/core";
import type { Avatars } from "@outstaff/core";
import type { DicebearOptions } from "./types.js";
import { STYLES } from "./styles.js";

/** Renders locally; no network. The same seed, style and background always give the same SVG. */
export function createDicebearAvatars(options: DicebearOptions): Avatars {
  const info = STYLES.get(options.style);
  if (!info) {
    throw new Error(`Unknown DiceBear style "${options.style}".`);
  }

  return {
    async render(seed, opts) {
      const size = opts?.size ?? options.size;
      const svg = createAvatar(info.style, {
        seed,
        ...(size ? { size } : {}),
        ...(options.background
          ? { backgroundColor: options.background.map((c) => c.replace(/^#/, "")) }
          : {}),
      }).toString();

      return { data: new TextEncoder().encode(svg), mime: "image/svg+xml" };
    },
  };
}
