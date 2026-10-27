import { buildPolicy } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import type { Decision } from "@outstaff/core";
import { decide, permissionHook, toToolCall } from "#/permissions.js";

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

describe("mapping SDK tools to neutral calls", () => {
  const cwd = "/work/main";

  it.each([
    ["Bash", { command: "ls" }, { kind: "shell", cwd, command: "ls" }],
    ["Bash", { command: "" }, { kind: "shell", cwd }],
    ["Bash", null, { kind: "shell", cwd }],
    ["Bash", "ls", { kind: "shell", cwd }],
    ["Read", { file_path: "/a" }, { kind: "read", cwd, path: "/a" }],
    ["Read", {}, { kind: "read", cwd }],
    ["Edit", { file_path: "/a" }, { kind: "edit", cwd, path: "/a" }],
    ["MultiEdit", { file_path: "/a" }, { kind: "edit", cwd, path: "/a" }],
    ["NotebookEdit", { notebook_path: "/n.ipynb" }, { kind: "edit", cwd, path: "/n.ipynb" }],
    ["Write", { file_path: "/a" }, { kind: "write", cwd, path: "/a" }],
    ["Grep", { path: "/src" }, { kind: "search", cwd, path: "/src" }],
    ["Glob", {}, { kind: "search", cwd }],
    ["WebFetch", { url: "https://acme.example" }, { kind: "web_fetch", cwd }],
    ["Task", {}, { kind: "subagent", cwd }],
    ["Agent", {}, { kind: "subagent", cwd }],
    ["ArtifactComments", {}, { kind: "artifact", cwd }],
    ["ToolSearch", {}, { kind: "artifact", cwd }],
  ])("maps %s %j", (tool, input, call) => {
    expect(toToolCall(tool, input, cwd)).toEqual(call);
  });

  it("has no call for a tool it does not know", () => {
    expect(toToolCall("Mystery", {}, cwd)).toBeUndefined();
    expect(toToolCall("mcp__other__ticket_create", {}, cwd)).toBeUndefined();
  });

  describe("the files an Artifact call publishes", () => {
    const sources = (input: unknown) => toToolCall("Artifact", input, cwd);

    it("is just the call without any file", () => {
      expect(sources({ action: "list" })).toEqual({ kind: "artifact", cwd });
      expect(sources({ file_path: "", file_paths: [], files: [] })).toEqual({
        kind: "artifact",
        cwd,
      });
    });

    it("lists the page, uploads and the root as paths", () => {
      expect(
        sources({ file_path: "/p.html", file_paths: ["/a.png", "", 7, "/b.png"], root: "/r" }),
      ).toEqual({
        kind: "artifact",
        cwd,
        path: "/p.html",
        paths: ["/r", "/a.png", "/b.png"],
      });
    });

    it("resolves a files array against the root, except absolute paths", () => {
      expect(
        sources({
          root: "/r",
          files: [{ path: "a.css" }, { path: "/abs/b.css" }, { path: "" }, null, {}],
        }),
      ).toEqual({ kind: "artifact", cwd, paths: ["/r", "/r/a.css", "/abs/b.css"] });
    });

    it("keeps a files array as given when there is no root", () => {
      expect(sources({ files: [{ path: "a.css" }] })).toEqual({
        kind: "artifact",
        cwd,
        paths: ["a.css"],
      });
    });

    it("reads a files map whose values are paths or objects with a source", () => {
      expect(
        sources({
          root: "/r",
          files: { "x.css": "x.css", "y.png": { from: "img/y.png" }, "z.js": null, "w.js": {} },
        }),
      ).toEqual({ kind: "artifact", cwd, paths: ["/r", "/r/x.css", "/r/img/y.png"] });
    });
  });
});

describe("the permission hook", () => {
  const seen: [string, unknown, Decision][] = [];
  const hook = permissionHook(chat, "/work/worktrees/app", (tool, input, decision) =>
    seen.push([tool, input, decision]),
  );

  const fire = (event: object) =>
    hook(event as never, "t1", { signal: new AbortController().signal });

  it("has no opinion on events other than PreToolUse", async () => {
    expect(await fire({ hook_event_name: "PostToolUse", tool_name: "Read" })).toEqual({});
    expect(seen).toEqual([]);
  });

  it("allows a call the policy allows, with the policy's reason", async () => {
    const out = await fire({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/work/repos/app/a.ts" },
    });

    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: seen.at(-1)![2].reason,
      },
    });

    expect(seen.at(-1)![0]).toBe("Read");
  });

  it("denies a call the policy denies, saying why, and reports the decision", async () => {
    const out = (await fire({
      hook_event_name: "PreToolUse",
      tool_name: "Mystery",
      tool_input: {},
      cwd: "/work/main",
    })) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };

    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(
      "Denied by the permission policy: Tool Mystery is not known to the permission policy.",
    );

    expect(seen.at(-1)![2]).toMatchObject({ effect: "deny", rule: "runtime.unknown-tool" });
  });

  it("always lets the harmless tools through", async () => {
    const out = (await fire({
      hook_event_name: "PreToolUse",
      tool_name: "Skill",
      tool_input: {},
    })) as { hookSpecificOutput: { permissionDecision: string } };

    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(seen.at(-1)![2].rule).toBe("runtime.harmless");
  });
});
