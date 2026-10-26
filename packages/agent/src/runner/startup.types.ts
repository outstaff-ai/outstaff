import type {
  AdapterRegistry,
  Logger,
  Policy,
  RenderedWorkdir,
  Runtime,
  SecretSource,
  TeamConfig,
} from "@outstaff/core";
import type { OfficeConnection } from "../office-client/index.js";
import type { ClonedRepo, SyncRepositoriesOptions } from "../repos/index.js";
import type { MiseRunner, ToolStatus } from "../tools/index.js";
import type { AgentEnv } from "../verbs/types.js";
import type { ChatRelay } from "./chat.types.js";
import type { WorkLoop } from "./loop.types.js";
import type { UsageReporter } from "./types.js";

export interface StartupOptions {
  /** The container environment: OUTSTAFF_PERSON, OUTSTAFF_OFFICE_URL and the team location variables. */
  env: NodeJS.ProcessEnv;

  /** The agent's home directory; the working files render into `<home>/work`. */
  home: string;
  registry: AdapterRegistry;

  /** Root of the installed stock catalog package. */
  stockCatalogDir: string;
  agentVersion: string;
  cwd?: string;

  /** Defaults to `envSecretSource(env)`. */
  secrets?: SecretSource;
  log?: Logger;

  /** Milliseconds between usage probes while idle. Default 600000 (10 minutes). */
  usageProbeEveryMs?: number;

  /** Replaces the WebSocket connection (tests only). */
  connection?: OfficeConnection;

  /** Overrides for cloning: the remote of each repo, the credential helper command, the git runner (tests only). */
  repositories?: Pick<SyncRepositoriesOptions, "remoteUrl" | "helper" | "git">;

  /** Overrides for tool installation: the mise runner and what to do with the shims directory (tests only). */
  tools?: { mise?: MiseRunner; addToPath?: (shimsDir: string) => void };
}

export interface PreparedAgent {
  person: string;
  team: TeamConfig;
  connection: OfficeConnection;
  loop: WorkLoop;

  /** Forwards usage to the office. Not started by `prepareAgent`: call `start()` once connected. */
  usage: UsageReporter;
  env: AgentEnv;
  runtime: Runtime;
  rendered: RenderedWorkdir;
  policy: Policy;
  systemPrompt: string;
  workdir: string;

  /** The repos cloned for the person, one per grant. */
  repos: ClonedRepo[];

  /** The declared tools and whether each is available. */
  tools: ToolStatus[];

  /** Listens on the agent's own chat identity; absent when the team has no chat or it cannot start. */
  chat?: ChatRelay;
}
