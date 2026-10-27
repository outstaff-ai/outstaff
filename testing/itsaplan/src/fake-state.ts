import type { StubReply } from "./types.js";
import type { Page } from "@outstaff/integration.shared.itsaplan";
import type {
  FakeOptions,
  StoredActivity,
  StoredAssignee,
  StoredColumn,
  StoredIssue,
  StoredLabel,
} from "./types.js";

const DEFAULT_COLUMNS = [
  { name: "Backlog", stateType: "backlog" },
  { name: "Ready", stateType: "unstarted" },
  { name: "In Progress", stateType: "started" },
  { name: "Review", stateType: "started" },
  { name: "Blocked", stateType: "started" },
  { name: "Done", stateType: "completed" },
  { name: "Canceled", stateType: "canceled" },
];

export const err = (status: number, error: string, code?: string): StubReply => ({
  status,
  body: { error, ...(code ? { code } : {}) },
});

/** The fake's data and the helpers its routes share. */
export function createFakeState(opts: FakeOptions) {
  const key = opts.projectKey ?? "SHOP";
  const teamRef = opts.teamRef ?? "acme";
  const ref = `${teamRef}.${key}`;
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + ++tick * 1000).toISOString();
  const columns: StoredColumn[] = (opts.columns ?? DEFAULT_COLUMNS).map((c, i) => ({
    id: 10 + i,
    projectId: 1,
    position: i,
    ...c,
  }));

  const labels: StoredLabel[] = [];
  const assignees: StoredAssignee[] = [
    { userId: "u-sam", name: "Sam Duarte", username: "sam", kind: "member" },
    { userId: "u-rio", name: "Rio Park", username: "rio", kind: "member" },
  ];

  const issues: StoredIssue[] = [];
  const activity: StoredActivity[] = [];
  let activityId = 100;
  let labelId = 500;
  const nextLabelId = () => ++labelId;

  const actor = assignees[0]!;
  const log = (
    issue: StoredIssue,
    entry: Pick<StoredActivity, "kind" | "action" | "body" | "payload"> & { replyToId?: number },
  ): StoredActivity => {
    const row: StoredActivity = {
      id: ++activityId,
      issueId: issue.id,
      issueSequence: issue.sequenceNumber,
      issueTitle: issue.title,
      replyToId: null,
      actorUserId: actor.userId,
      actorName: actor.name,
      createdAt: clock(),
      ...entry,
    };

    activity.push(row);
    return row;
  };

  const isProject = (p: string) => p === key || p === ref;
  const issueBySeq = (seq: string) => issues.find((i) => i.sequenceNumber === Number(seq));
  const attachments: { issueId: number; name: string; mimetype: string; data: Uint8Array }[] = [];
  const issueById = (id: string) => issues.find((i) => i.id === Number(id));
  const touch = (i: StoredIssue) => void (i.updatedAt = clock());

  const create = (b: {
    title: string;
    description?: string;
    columnId: number;
    assigneeUserId?: string;
    labelIds?: number[];
    parentId?: number;
  }): StoredIssue => {
    const seq = issues.length + 1;
    const issue: StoredIssue = {
      id: 1000 + seq,
      sequenceNumber: seq,
      identifier: `${key}-${seq}`,
      title: b.title,
      description: b.description ?? "",
      columnId: b.columnId,
      assigneeUserId: b.assigneeUserId ?? null,
      labelIds: b.labelIds ?? [],
      parentId: b.parentId ?? null,
      createdAt: clock(),
      updatedAt: clock(),
    };

    issues.push(issue);
    log(issue, { kind: "history", action: "created", body: null, payload: {} });
    return issue;
  };

  const column = (id: number) => columns.find((c) => c.id === id);

  const page = <T extends { id: number; createdAt: string }>(
    all: T[],
    query: URLSearchParams,
    newestFirst: boolean,
  ): Page<T> => {
    const limit = Math.min(Number(query.get("limit") ?? 25), 100);
    const cursor = query.get("cursor")
      ? (JSON.parse(query.get("cursor")!) as { id: number })
      : null;

    let rows = all.toSorted((a, b) => (newestFirst ? b.id - a.id : a.id - b.id));
    if (cursor) {
      rows = rows.filter((r) => (newestFirst ? r.id < cursor.id : r.id > cursor.id));
    }

    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > limit && last ? { nextCursor: { ts: last.createdAt, id: last.id } } : {}),
    };
  };

  return {
    key,
    teamRef,
    ref,
    clock,
    columns,
    labels,
    assignees,
    issues,
    activity,
    attachments,
    actor,
    log,
    isProject,
    issueBySeq,
    issueById,
    touch,
    create,
    column,
    page,
    nextLabelId,
  };
}
