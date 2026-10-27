import type { Avatars } from "#/ports/index.js";

function hash(text: string): number {
  let h = 2166136261;
  for (const ch of text) {
    h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  }

  return h;
}

export function createFakeAvatars(): Avatars {
  return {
    async render(seed, opts) {
      const size = opts?.size ?? 128;
      const hue = hash(seed) % 360;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 60% 55%)"/></svg>`;
      return { data: new TextEncoder().encode(svg), mime: "image/svg+xml" };
    },
  };
}
