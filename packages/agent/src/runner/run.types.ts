/** Runs a prepared agent and prepares it again when the office's team config changes. */
export interface AgentRunner {
  /** Resolves when the agent stopped: 1 when the office refused it, else 0. A startup problem rejects. */
  run(): Promise<number>;

  /** Interrupts the running item, closes the connection and ends `run`. Safe to call more than once. */
  stop(signal: string): void;
}
