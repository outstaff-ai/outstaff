import type {
  ChatSeed,
  KnowledgeSeed,
  RuntimeSeed,
  TrackerSeed,
  VcsSeed,
} from "../contracts/seeds.js";
import type { ToolCall } from "../permissions/index.js";
import type {
  AgentProfile,
  Chat,
  ChatMessage,
  Knowledge,
  Member,
  NewAttachment,
  RunRequest,
  Runtime,
  StatusMap,
  Tracker,
  UsageEvent,
  Vcs,
} from "../ports/index.js";

export interface FakeChatOptions {
  /** Posts longer than this are split at line breaks, as a real adapter does. Default 4000. */
  maxMessageLength?: number;
  now?: () => Date;
}

export interface FakeChat extends Chat {
  seed: ChatSeed;

  /** Every message the adapter posted, one entry per platform message. */
  posts: ChatMessage[];
  reactions: { channel: string; messageId: string; name: Parameters<Chat["react"]>[2] }[];
  profiles: Map<string, AgentProfile>;

  /** Every profile published, in order, with the user it was published for. */
  profileLog: { userId: string; profile: AgentProfile }[];
  setAgentProfile(userId: string, profile: AgentProfile): Promise<void>;
  onProfileRequest(source: (userId: string) => Promise<AgentProfile | undefined>): void;

  /** The bytes of every file seeded with an inbound message, by file id. */
  files: Map<string, Uint8Array>;

  /** What the adapter does when a user opens the profile page: asks the source registered with `onProfileRequest`. */
  openProfile(userId: string): Promise<AgentProfile | undefined>;
}

export interface FakeKnowledgeOptions {
  baseUrl?: string;
  author?: string;
  now?: () => Date;
}

export interface FakeKnowledge extends Knowledge {
  seed: KnowledgeSeed;
}

export type FakeRunStep =
  | { type: "text"; text: string }

  /** The call is judged against the request's policy with `evaluate()`; the decision lands in the emitted event. */
  | { type: "tool_call"; tool: string; call: ToolCall }
  | UsageEvent
  | {
      type: "finish";
      ok?: boolean;
      text?: string;
      error?: string;
      costUsd?: number;
      sessionLost?: boolean;
    };

export interface FakeRuntime extends Runtime {
  seed: RuntimeSeed;

  /** Queue steps for the next run. Runs with nothing queued say "ok". */
  enqueue(steps: FakeRunStep[]): void;
  requests: RunRequest[];
  usage: UsageEvent;
  probeUsage(): Promise<UsageEvent>;
}

export interface FakeTrackerOptions {
  statusMap?: StatusMap;
  baseUrl?: string;
  keyPrefix?: string;

  /** Who the events and comments are attributed to. */
  actor?: Member;
  now?: () => Date;
}

export interface FakeTracker extends Tracker {
  /** The same tracker seen by another identity: its calls are attributed to `identity`, as an adapter with its own credentials. */
  as(identity: Member): FakeTracker;
  seed: TrackerSeed;
  relations: { key: string; otherKey: string; relation: Parameters<Tracker["link"]>[2] }[];

  /** Real parents set with `setParent`: child key to parent key. */
  parents: Map<string, string>;

  /** Every file attached, by ticket key. */
  attached: Map<string, NewAttachment[]>;
}

export interface FakeVcsOptions {
  /** Host used for URLs and for repos without one. */
  host?: string;
  now?: () => Date;

  /** The login the fake acts as when `resolveThread` gets no `asLogin`. Default "sam". */
  login?: string;

  /** How many times `getPullRequest({ waitForMergeable })` re-reads an `unknown` value. Default 5. */
  mergeableRetries?: number;
}

export interface FakeVcs extends Vcs {
  seed: VcsSeed;
}

export interface FakeClock {
  now: () => Date;
}
