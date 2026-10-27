import type { Logger, Policy, Runtime, TeamConfig, ToolKind } from "@outstaff/core";
import type { OfficeConnection } from "#/office-client/index.js";
import type { ClonedRepo, Workspaces } from "#/repos/index.js";
import type { AgentEnv } from "#/verbs/types.js";
import type { ChatRelay } from "./chat.types.js";
import type { ProfilePublisher, SessionManager, UsageReporter } from "./types.js";

/** What the loop uses of the office connection. Heartbeats are sent by the connection itself while an item is accepted. */
export type WorkConnection = Pick<
  OfficeConnection,
  | "offers"
  | "accept"
  | "decline"
  | "progress"
  | "handBack"
  | "fail"
  | "session"
  | "journal"
  | "resume"
>;

export interface WorkLoopOptions {
  office: WorkConnection;
  runtime: Runtime;

  /** The name of the runtime adapter, reported to the office with each accepted item. */
  runtimeName: string;

  /** The ports and identity the verbs use. Its `office` is wrapped to see whether the agent asked something. */
  env: AgentEnv;
  systemPrompt: string;
  policy: Policy;
  builtinTools: ToolKind[];
  workdir: string;
  addDirs: string[];

  /**
   * How chat sessions run: beside the active item, with their own policy (see the `chat` permission profile) and
   * no worktree. Without it a chat item runs like any other item.
   */
  chatSession?: { policy: Policy; builtinTools: ToolKind[] };

  /** Per-item worktree and scratch directory. Without it items run in `workdir` alone. */
  workspaces?: Workspaces;

  /** The repositories the person has a grant on, listed in the work prompt with their access. */
  repos?: ClonedRepo[];
  model?: string;
  maxTurns?: number;
  sessions?: SessionManager;

  /** Gets the usage events of the runtime and learns when the agent is busy. */
  usage?: Pick<UsageReporter, "observe" | "flush" | "setBusy">;

  /** Chat requests: the context a new chat session starts with, and the report to the requester. */
  chat?: Pick<ChatRelay, "context" | "report" | "acknowledge" | "attachments">;
  log?: Logger;

  /** Told when the work or the agent's status changes, so the chat profile follows. */
  profile?: Pick<ProfilePublisher, "changed">;

  /** The team's `policies`; `acknowledge.vcs` decides whether feedback gets a reaction. */
  policies?: TeamConfig["policies"];

  /** Least time between two progress messages for an item. Default 30000. */
  progressEveryMs?: number;
  now?: () => number;
}

export interface WorkLoop {
  /**
   * Takes work items one at a time, and chat sessions beside them, until the connection ends or `stop` is called.
   * The office decides how many chat sessions it offers.
   */
  run(): Promise<void>;

  /** Takes no new items, lets the running ones finish, and ends `run`. */
  drain(): Promise<void>;

  /** Interrupts the running item, hands it back as interrupted, and ends `run`. */
  stop(): Promise<void>;
}

/** What one item's run needs from the loop. */
export interface WorkerContext {
  opts: WorkLoopOptions;
  log: Logger;
  sessions: SessionManager;
}

/** The verbs' environment for one item, and what the agent did through it. */
export interface ItemEnv {
  env: AgentEnv;

  /** The last status the agent moved each ticket to in this run. */
  moved: Map<string, string>;

  /** Whether the agent asked a question that is still open. */
  asked(): boolean;

  /** Whether a chat session filed its request as work. */
  filedWork(): boolean;
}
