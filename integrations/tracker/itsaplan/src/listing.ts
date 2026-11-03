import type { IssueFilter, Tracker } from "@outstaff/core";
import type { ApiIssue, ApiProject, Itsaplan } from "@outstaff/integration.shared.itsaplan";
import type { issueHelpers } from "./issues.js";
import type { Statuses } from "./types.js";

/** The most issues one listing request returns. */
const MAX_LIST = 500;

type Helpers = Pick<
  ReturnType<typeof issueHelpers>,
  "toIssue" | "fetchIssue" | "labelIds" | "hydrate"
>;

/** The `labelIds` query of a label filter: undefined for none, null when the project has no such label. */
async function labelQuery(h: Helpers, label: string | undefined) {
  if (label === undefined) {
    return undefined;
  }

  const ids = await h.labelIds([label], false);
  return ids.length ? ids.join(",") : null;
}

/** Unassigned tickets are picked out of the answer, so then ask for the most it gives. Else the API's default. */
function limitQuery(filter: IssueFilter): number | undefined {
  if (filter.assignee === null) {
    return MAX_LIST;
  }

  return filter.limit === undefined ? undefined : Math.min(filter.limit, MAX_LIST);
}

/** The columns of the wanted canonical statuses; one entry without a column when any status will do. */
function columnsOf(statuses: Statuses, setup: ApiProject, wanted: IssueFilter["status"]) {
  if (!wanted) {
    return [undefined];
  }

  return setup.columns
    .filter((c) => {
      const canonical = statuses.status(setup, c.id).canonical;
      return canonical !== undefined && wanted.includes(canonical);
    })
    .map((c) => c.id);
}

/** `listIssues`: one request a column, since a status is any column of it and the API takes one column a request. */
export function issueListing(api: Itsaplan, statuses: Statuses, h: Helpers): Tracker["listIssues"] {
  return async (filter) => {
    const setup = await api.project();
    const labelIds = await labelQuery(h, filter.label);
    if (labelIds === null) {
      return [];
    }

    const query = {
      assigneeUserId: filter.assignee ? api.resolveMemberId(setup, filter.assignee) : undefined,
      labelIds,
      parentId: filter.parent ? (await h.fetchIssue(filter.parent)).id : undefined,
      initiativeId: filter.initiative,
      updatedFrom: filter.updatedSince,
      limit: limitQuery(filter),
    };

    const pages = await Promise.all(
      columnsOf(statuses, setup, filter.status).map((columnId) =>
        api.http.request<ApiIssue[]>("GET", `${api.projectPath}/issues`, {
          query: { ...query, columnId },
        }),
      ),
    );

    // The API has no filter for unassigned tickets.
    const items = pages
      .flat()
      .filter((i) => filter.assignee !== null || !i.assigneeUserId)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, filter.limit);

    return filter.brief ? items.map((i) => h.toIssue(i, setup)) : h.hydrate(items, setup);
  };
}
