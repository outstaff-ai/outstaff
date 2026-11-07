import type { Profile, ProfileSpec, ToolKind } from "./types.js";

/**
 * The verbs a chat session may call: look at the team, the work, tickets, milestones, documents and pull requests,
 * comment, file work, place queued work where the requester says, change a ticket (assign, move, re-parent, link, edit),
 * file a confirmed plan's milestones and start, close or drop a milestone on a trusted human's request, and keep the
 * agent's own notes. Nothing that changes a pull request, a document or code.
 */
export const CHAT_VERBS = [
  "me",
  "team",
  "work",
  "work.queue",
  "work.attach",
  "work.move",
  "doc.search",
  "doc.show",
  "note.list",
  "note.add",
  "note.update",
  "note.remove",
  "ticket.show",
  "ticket.list",
  "ticket.comment",
  "ticket.create",
  "ticket.attach",
  "ticket.assign",
  "ticket.move",
  "ticket.parent",
  "ticket.link",
  "ticket.edit",
  "milestone.list",
  "milestone.show",
  "milestone.create",
  "milestone.add",
  "milestone.status",
  "pr.list",
  "pr.status",
  "pr.checks",
  "ci.log",
  "usage",
  "pr.threads",
  "pr.conversation",
  "pr.diff",
  "pr.comment",
  "recall",
];

const WORK_TOOLS: ToolKind[] = [
  "read",
  "write",
  "edit",
  "search",
  "shell",
  "web_fetch",
  "subagent",
  "ost",
];

/**
 * Every profile runs any program inside the sandbox; the profiles differ in what they may change in repositories.
 *
 * readonly: read-only git even where a write grant exists; the edit tools change no repository file.
 * docs:     the edit tools change only documentation files (md, mdx, txt, rst and anything under docs/) in worktrees
 *           of write repos; git write verbs and pushes for write repos.
 * code:     the edit tools change any file in worktrees of write repos.
 * infra:    like code, for infrastructure repos.
 * chat:     a chat session beside a running work item. The same tools as a work session, but read-only git, no
 *           repository edits, and only the `ost` verbs in CHAT_VERBS.
 *
 * Every profile may write its scratch, harness (`~/.claude/projects`) and tmp folders. Memory, `memory/` and Claude
 * Code's own auto-memory alike, is changed with `ost note` only.
 */
export const PROFILE_SPECS: Record<Profile, ProfileSpec> = {
  readonly: { tools: WORK_TOOLS, honoursWrite: false, writable: "none" },
  docs: { tools: WORK_TOOLS, honoursWrite: true, writable: "docs" },
  code: { tools: WORK_TOOLS, honoursWrite: true, writable: "all" },
  infra: { tools: WORK_TOOLS, honoursWrite: true, writable: "all" },
  chat: { tools: WORK_TOOLS, honoursWrite: false, writable: "none", verbs: CHAT_VERBS },
};

/** Whether a profile honours write grants; the one place that decides it. */
export const profileAllowsWrite = (profile: Profile): boolean =>
  PROFILE_SPECS[profile].honoursWrite;
