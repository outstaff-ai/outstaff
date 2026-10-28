import { createRouter, type Route } from "@outstaff/testing.http";
import { attachmentRoutes } from "./attachment-routes.js";
import { docCommentRoutes } from "./doc-comment-routes.js";
import { documentRoutes } from "./document-routes.js";
import { issueRoutes } from "./issue-routes.js";
import { projectRoutes } from "./project-routes.js";
import { createStore, err } from "./store.js";
import type { ActorRoute, ItsaplanStore, StandInOptions } from "./types.js";

/** Every route needs a known API key; the handler gets the member it acts as. */
function guarded(s: ItsaplanStore, basePath: string, route: ActorRoute): Route {
  return {
    method: route.method,
    path: `${basePath}${route.path}`,
    handler: (r) => {
      const actor = s.keys[r.headers.get("x-api-key") ?? ""];
      return actor ? route.handler(r, actor) : err(401, "Unknown API key.", "unauthorized");
    },
  };
}

/**
 * The parts of the Its a Plan REST API the tracker and knowledge adapters use: the project, issues, comments,
 * attachments, the activity feed, links, documents and their comment threads. One implementation, served in
 * process to the adapter tests and over HTTP to the end-to-end run; what differs between them is in `opts`.
 */
export function createItsaplanStandIn(opts: StandInOptions = {}) {
  const store = createStore(opts);
  const routes = [
    ...documentRoutes(store),
    ...docCommentRoutes(store),
    ...projectRoutes(store),
    ...issueRoutes(store),
    ...attachmentRoutes(store),
  ].map((r) => guarded(store, opts.basePath ?? "", r));

  return { store, routes, dispatch: createRouter(routes) };
}
