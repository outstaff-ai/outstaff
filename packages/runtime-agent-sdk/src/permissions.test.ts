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

describe("the Design canvas in the SDK hook", () => {
  const build = (capabilities: "design.canvas"[]) =>
    buildPolicy({
      profile: "docs",
      person: { repos: {} },
      team: { repos: [] },
      layout,
      capabilities,
    });

  const canvas = build(["design.canvas"]);
  const plain = build([]);

  it.each([
    ["Artifact", { action: "list" }],
    ["ArtifactComments", {}],
    ["ToolSearch", { query: "select:ArtifactComments" }],
    ["Artifact", { file_path: "/home/agent/artifacts/home.html" }],
    [
      "Artifact",
      {
        file_path: "/home/agent/artifacts/home.html",
        files: { "a.css": "a.css" },
        root: "/home/agent/artifacts",
      },
    ],
  ])("allows %s with the capability", (tool, input) => {
    expect(decide(canvas, tool, input, "/work/main").effect).toBe("allow");
  });

  it.each([
    ["Artifact", { action: "list" }],
    ["ArtifactComments", {}],
    ["Artifact", { file_path: "/home/agent/artifacts/home.html" }],
  ])("denies %s without it", (tool, input) => {
    expect(decide(plain, tool, input, "/work/main").effect).toBe("deny");
  });

  it("refuses to publish a file the person may not read", () => {
    const secret = { file_path: "/work/secrets/CLAUDE_CODE_OAUTH_TOKEN" };
    expect(decide(canvas, "Artifact", secret, "/work/main").effect).toBe("deny");
    const viaFiles = {
      file_path: "/home/agent/artifacts/a.html",
      files: { "k.txt": "/work/secrets/k" },
    };

    expect(decide(canvas, "Artifact", viaFiles, "/work/main").effect).toBe("deny");
  });

  it("lets the person write and read the artifacts folder, and only with the capability", () => {
    const write = { file_path: "/home/agent/artifacts/home.html" };
    expect(decide(canvas, "Write", write, "/work/main").effect).toBe("allow");
    expect(decide(canvas, "Read", write, "/work/main").effect).toBe("allow");
    expect(decide(plain, "Write", write, "/work/main").effect).toBe("deny");
  });
});
