import type { ApiDocSummary } from "@outstaff/integration.shared.itsaplan";
import type { Tree } from "./types.js";

// Documents form a tree; a path is the titles from the root, or the path stored in metadata.

export const segments = (path: string) =>
  path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A document's tree path from the titles of its ancestors. */
function titlePath(d: ApiDocSummary, byId: Map<number, ApiDocSummary>): string {
  const parts: string[] = [];
  for (let cur: ApiDocSummary | undefined = d; cur; cur = byId.get(cur.parentId ?? -1)) {
    parts.unshift(cur.title);
    if (parts.length > 50) {
      break;
    }
  }

  return parts.join("/");
}

// The stored path (kept in metadata) wins; pages made in the web app fall back to their ancestors' titles.
export const pathOf = (d: ApiDocSummary, byId: Map<number, ApiDocSummary>) =>
  d.metadata?.path ?? titlePath(d, byId);

export function find(tree: Tree, path: string): ApiDocSummary | undefined {
  const wanted = segments(path).join("/");
  return (
    tree.items.find((d) => d.metadata?.path !== undefined && same(d.metadata.path, wanted)) ??
    tree.items.find((d) => same(titlePath(d, tree.byId), wanted))
  );
}
