import type { RepoRef } from "#/ports/types.js";
import type { PrRef, StaticWorkflowData, WorkflowState } from "./types.js";

const k = (r: PrRef) => `${r.repo.owner}/${r.repo.name}#${r.number}`;

/** A WorkflowState backed by plain data; used by tests and by the replay of acme events. */
export function createStaticWorkflowState(data: StaticWorkflowData): WorkflowState {
  const prs = data.prs ?? [];
  return {
    ticketForPr: (pr) => data.links?.[pr.number],
    ticketStatus: (t) => data.tickets?.[t]?.status,
    assignee: (t) => data.tickets?.[t]?.assignee,
    pullRequest: (pr) => prs.find((p) => k(p.ref) === k(pr)),
    pullRequestsOf: (t) => prs.filter((p) => data.links?.[p.ref.number] === t),
    handedBack: (t) => data.tickets?.[t]?.handedBack ?? false,
    lastWorker: (t) => data.tickets?.[t]?.lastWorker,
    blockedAgent: (t) => data.tickets?.[t]?.blockedAgent,
    inRound: (t, person, at) =>
      (data.tickets?.[t]?.rounds ?? []).some(
        (r) =>
          r.person === person &&
          Date.parse(r.from) <= Date.parse(at) &&
          (r.to === undefined || Date.parse(at) <= Date.parse(r.to)),
      ),
    requester: (t) => data.tickets?.[t]?.requester,
    hasLabel: (t, label) => data.tickets?.[t]?.labels?.includes(label) ?? false,
    defaultBranch: () => data.defaultBranch ?? "main",
    stackedOn: (repo: RepoRef, branch) =>
      prs.filter(
        (p) =>
          p.ref.repo.owner === repo.owner && p.ref.repo.name === repo.name && p.baseRef === branch,
      ),
    docAuthor: (doc) => data.docs?.[doc],
    personForRole: (role) => data.roles?.[role],
  };
}
