import { buildPolicy } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { decide, toToolCall } from "./permissions.js";

const layout = {
  home: "/home/agent",
  workDir: "/work/main",
  reposDir: "/work/repos",
  worktreesDir: "/work/worktrees",
  scratchDir: "/work/scratch",
  memoryDir: "/work/memory",
  secretsDir: "/work/secrets",
};

const chat = buildPolicy({
  profile: "chat",
  person: { repos: { app: "write" } },
  team: {
    repos: [
      { name: "app", url: "git.acme.example/acme/app", kind: "primary", default_branch: "main" },
    ],
  },
  layout,
});

describe("the chat profile in the SDK hook", () => {
  it("names the verb of an ost tool call", () => {
    expect(toToolCall("mcp__ost__ticket_create", {}, "/work/main")).toEqual({
      kind: "ost",
      cwd: "/work/main",
      command: "ticket.create",
    });
  });

  it.each([
    ["mcp__ost__ticket_create", {}, "allow"],
    ["mcp__ost__ticket_comment", {}, "allow"],
    ["mcp__ost__pr_open", {}, "deny"],
    ["mcp__ost__ticket_move", {}, "deny"],
    ["Write", { file_path: "/work/worktrees/app/a.ts" }, "deny"],
    ["Edit", { file_path: "/work/worktrees/app/a.ts" }, "deny"],
    ["Read", { file_path: "/work/repos/app/a.ts" }, "allow"],
    ["Bash", { command: "git push origin HEAD", cwd: "/work/worktrees/app" }, "deny"],
  ])("judges %s as %s", (tool, input, effect) => {
    expect(decide(chat, tool, input, "/work/worktrees/app").effect).toBe(effect);
  });
});
