import type { ApiProject } from "@outstaff/integration.tracker.itsaplan";
import { columnOf, createIssue } from "./model.js";
import { err } from "./store.js";
import type { ActorRoute, ItsaplanStore, StoredIssue } from "./types.js";

const summary = ({ description: _d, ...rest }: StoredIssue) => rest;

/** The project, its labels, and the issue listings and search. */
export function projectRoutes(s: ItsaplanStore): ActorRoute[] {
  const isProject = (p: string) => p === s.key || p === s.ref;
  return [
    {
      method: "GET",
      path: "/projects/:p",
      handler: (r) =>
        isProject(r.params["p"]!)
          ? ({
              project: { ...s.project, teamRef: s.teamRef, key: s.key, ref: s.ref },
              columns: s.columns,
              labels: s.labels,
              assignees: s.members,
            } satisfies ApiProject)
          : err(404, "project not found"),
    },
    {
      method: "POST",
      path: "/projects/:p/labels",
      handler: (r) => {
        const label = { id: ++s.counters.label, projectId: 1, name: r.json.name as string };
        s.labels.push(label);
        return { status: 201, body: label };
      },
    },
    {
      method: "GET",
      path: "/projects/:p/issues/search",
      handler: (r) => {
        const q = (r.query.get("q") ?? "").toLowerCase();
        return s.issues
          .filter((i) => `${i.title} ${i.description}`.toLowerCase().includes(q))
          .slice(0, Number(r.query.get("limit") ?? 50))
          .map(summary);
      },
    },
    {
      method: "GET",
      path: "/projects/:p/issues/:seq",
      handler: (r) =>
        s.issues.find((i) => i.sequenceNumber === Number(r.params["seq"])) ??
        err(404, "issue not found"),
    },
    {
      method: "GET",
      path: "/projects/:p/issues",
      handler: (r) => {
        const col = r.query.get("columnId");
        const who = r.query.get("assigneeUserId");
        const since = r.query.get("updatedFrom");
        return s.issues
          .filter((i) => (col ? i.columnId === Number(col) : true))
          .filter((i) => (who ? i.assigneeUserId === who : true))
          .filter((i) => (since ? i.updatedAt >= since : true))
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, Number(r.query.get("limit") ?? 50))
          .map(summary);
      },
    },
    {
      method: "POST",
      path: "/projects/:p/issues",
      handler: (r, actor) =>
        columnOf(s, Number(r.json.columnId))
          ? { status: 201, body: createIssue(s, actor, r.json) }
          : err(400, "unknown column"),
    },
  ];
}
