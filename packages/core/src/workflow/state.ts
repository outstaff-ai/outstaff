import type { RepoRef } from "../ports/repo.js";
import type { CanonicalStatus } from "../ports/status.js";
import type { PrRef, WorkflowPr, WorkflowState } from "./types.js";

export interface StaticTicket {
  status: CanonicalStatus;
  assignee?: { id: string; kind: "human" | "agent" };
  lastWorker?: string;
  requester?: string;
  labels?: string[];
}

export interface StaticWorkflowData {
  tickets?: Record<string, StaticTicket>;
  prs?: WorkflowPr[];

  /** Pull request number -> ticket key (same repo assumed per entry's `ref.repo`). */
  links?: Record<number, string>;
  roles?: Record<string, string>;
}

const k = (r: PrRef) => `${r.repo.owner}/${r.repo.name}#${r.number}`;

/** A WorkflowState backed by plain data; used by tests and by `ost workflow explain` fixtures. */
export function createStaticWorkflowState(data: StaticWorkflowData): WorkflowState {
  const prs = data.prs ?? [];
  return {
    ticketForPr: (pr) => data.links?.[pr.number],
    ticketStatus: (t) => data.tickets?.[t]?.status,
    assignee: (t) => data.tickets?.[t]?.assignee,
    pullRequest: (pr) => prs.find((p) => k(p.ref) === k(pr)),
    lastWorker: (t) => data.tickets?.[t]?.lastWorker,
    requester: (t) => data.tickets?.[t]?.requester,
    hasLabel: (t, label) => data.tickets?.[t]?.labels?.includes(label) ?? false,
    stackedOn: (repo: RepoRef, branch) =>
      prs.filter(
        (p) =>
          p.ref.repo.owner === repo.owner && p.ref.repo.name === repo.name && p.baseRef === branch,
      ),
    personForRole: (role) => data.roles?.[role],
  };
}
