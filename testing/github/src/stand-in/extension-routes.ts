import type { Route } from "@outstaff/testing.http";
import type { BareRepo } from "./bare-repo.js";
import { NOT_FOUND } from "./model.js";

/**
 * Repositories that hold gh script extensions, as `gh extension install --pin` reads them: the repository, no
 * releases (so the extension is a script, cloned with git), the script at the root, and the commit a tag names.
 */
export function extensionRoutes(api: string, repos: BareRepo[]): Route[] {
  return repos.flatMap((r): Route[] => {
    const base = `${api}/repos/${r.owner}/${r.name}`;
    return [
      {
        method: "GET",
        path: base,
        handler: () => ({
          name: r.name,
          full_name: `${r.owner}/${r.name}`,
          default_branch: "main",
        }),
      },
      { method: "GET", path: `${base}/releases/latest`, handler: () => NOT_FOUND },
      { method: "GET", path: `${base}/releases/tags/:tag`, handler: () => NOT_FOUND },
      {
        method: "GET",
        path: `${base}/contents/:path`,
        handler: async (q) =>
          (await r.has(q.params["path"]!)) ? { path: q.params["path"], type: "file" } : NOT_FOUND,
      },
      {
        method: "GET",
        path: `${base}/commits/:ref`,
        handler: async (q) => {
          const sha = await r.resolve(q.params["ref"]!);
          return sha ? { text: sha } : { status: 422, body: { message: "No commit found" } };
        },
      },
    ];
  });
}
