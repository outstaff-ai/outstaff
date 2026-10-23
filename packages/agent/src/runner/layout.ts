import { join } from "node:path";
import type { Layout } from "@outstaff/core";

/** The directories of an agent container, below the agent's home. */
export function agentLayout(home: string, secretsDir: string): Layout {
  return {
    home,
    workDir: join(home, "work"),
    reposDir: join(home, "repos"),
    worktreesDir: join(home, "worktrees"),
    scratchDir: join(home, "scratch"),
    memoryDir: join(home, "memory"),
    secretsDir,
  };
}
