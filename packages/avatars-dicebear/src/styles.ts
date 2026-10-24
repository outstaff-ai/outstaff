import * as collection from "@dicebear/collection";
import type { Style } from "@dicebear/core";

export interface StyleInfo {
  id: string;
  style: Style<object>;
  creator: string;
  license: string;

  /** CC0, MIT and similar: no attribution needed. */
  permissive: boolean;
}

export const DEFAULT_STYLE = "notionists";

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// Licenses that need no attribution. Everything else (CC BY, the "free for personal and commercial use" terms) is flagged.
const PERMISSIVE = /^(CC0|MIT)/;

type Meta = { creator?: string; license?: { name?: string } };

export const STYLES: ReadonlyMap<string, StyleInfo> = new Map(
  Object.entries(collection).map(([key, style]) => {
    const meta = (style as { meta?: Meta }).meta ?? {};
    const license = meta.license?.name ?? "unknown";
    const id = kebab(key);
    return [
      id,
      {
        id,
        style: style as Style<object>,
        creator: meta.creator ?? "unknown",
        license,
        permissive: PERMISSIVE.test(license),
      },
    ];
  }),
);

export const STYLE_IDS = [...STYLES.keys()] as [string, ...string[]];
