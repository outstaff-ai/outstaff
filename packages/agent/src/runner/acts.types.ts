import type { Logger } from "@outstaff/core";
import type { QueuedAct } from "@outstaff/protocol";
import type { OfficeConnection } from "#/office-client/index.js";
import type { AgentEnv } from "#/verbs/types.js";

export interface ActMakerOptions {
  /** The agent's own ports: its changes are made with its credentials. */
  env: Pick<AgentEnv, "team" | "tracker" | "knowledge">;
  office: Pick<OfficeConnection, "actResult">;
  log: Logger;
}

/** Makes the acts the office hands the agent. */
export interface ActMaker {
  /** Queues the acts after the ones before them; resolves once they are made and answered. Never rejects. */
  make(acts: QueuedAct[]): Promise<void>;
}
