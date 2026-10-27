import type { Policy, RunRequest } from "@outstaff/core";
import type { Offer } from "../office-client/index.js";
import type { Workspace } from "../repos/index.js";
import { VERBS, createRuntimeTools } from "../verbs/index.js";
import type { AgentEnv } from "../verbs/types.js";
import { itemEnv, itemFiles } from "./item-env.js";
import type { WorkerContext, WorkLoopOptions } from "./loop.types.js";
import { buildWorkPrompt } from "./prompt.js";
import type { Attachment } from "./types.js";
import type { ItemRun } from "./work.types.js";

export const CHAT_KIND = "chat";

type ChatSession = WorkLoopOptions["chatSession"];

/** The verbs the policy lets the agent use. */
const allowedVerbs = (policy: Policy) => {
  const allow = policy.ost?.allow;

  return allow ? VERBS.filter((v) => allow.includes(v.name)) : VERBS;
};

interface RequestParts {
  id: string;
  policy: Policy;
  session: ChatSession;
  workspace: Workspace | undefined;
  env: AgentEnv;
  abort: AbortController;
}

function buildRequest(
  opts: WorkLoopOptions,
  parts: RequestParts,
  prompt: string,
  resume: string | undefined,
): RunRequest {
  const { workspace, policy } = parts;

  return {
    ...(resume ? { sessionId: resume } : {}),
    workItemId: parts.id,
    prompt,
    systemPrompt: opts.systemPrompt,
    workdir: opts.workdir,
    addDirs: workspace ? [...opts.addDirs, workspace.worktree, workspace.scratch] : opts.addDirs,
    policy,
    tools: createRuntimeTools(
      parts.env,
      allowedVerbs(policy),
      workspace ? { cwd: workspace.worktree } : {},
    ),
    builtinTools: parts.session?.builtinTools ?? opts.builtinTools,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
    signal: parts.abort.signal,
  };
}

interface PromptParts {
  storedSession: string | undefined;
  workspace: Workspace | undefined;
  attachments: Attachment[];
  ticketFiles: Record<string, Attachment[]>;
}

function buildPrompt(
  opts: WorkLoopOptions,
  offer: Offer,
  parts: PromptParts,
  restarted: boolean,
  context: string | undefined,
): string {
  const { workspace } = parts;

  return buildWorkPrompt(offer, {
    resumed: parts.storedSession !== undefined && !restarted,
    restarted,
    ...(opts.env.layout ? { docsDir: opts.env.layout.workDir } : {}),
    ...(offer.interrupted ? { interrupted: true } : {}),
    ...(workspace ? { workspace } : {}),
    ...(opts.repos?.length ? { repos: opts.repos } : {}),
    ...(context ? { chatContext: context } : {}),
    attachments: parts.attachments,
    ticketFiles: parts.ticketFiles,
  });
}

/** The chat thread so far, for a new session of an item that came from chat; a resumed session already knows it. */
async function chatContextFor(
  opts: WorkLoopOptions,
  offer: Offer,
  storedSession: string | undefined,
): Promise<string | undefined> {
  if (!offer.workItem.origin || storedSession) {
    return undefined;
  }

  return opts.chat?.context(offer);
}

/** Everything an accepted item runs with: its session, policy, worktree, files and verbs' environment. */
export async function setUpItem(
  { opts, log, sessions }: WorkerContext,
  offer: Offer,
  abort: AbortController,
): Promise<ItemRun> {
  const id = offer.workItem.id;
  const storedSession = sessions.resumeFor(offer);

  // A chat session reads and answers; it has no worktree and runs under the chat policy.
  const session = offer.workItem.kind === CHAT_KIND ? opts.chatSession : undefined;
  const policy = session?.policy ?? opts.policy;
  const workspace = session ? undefined : await opts.workspaces?.prepare(offer);
  const chatContext = await chatContextFor(opts, offer, storedSession);
  const files = await itemFiles(opts, offer, log);
  const item = itemEnv(opts, offer, files, log);
  const requestParts = { id, policy, session, workspace, env: item.env, abort };
  const promptParts = { storedSession, workspace, ...files };

  return {
    offer,
    abort,
    storedSession,
    chatContext,
    item,
    request: (prompt, resume) => buildRequest(opts, requestParts, prompt, resume),
    prompt: (restarted, context) => buildPrompt(opts, offer, promptParts, restarted, context),
    current: storedSession,
    lastText: "",
  };
}
