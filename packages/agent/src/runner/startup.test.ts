import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterRegistry, defineAdapter, evaluate, repoAccess } from "@outstaff/core";
import { createFakeAdapterRegistry, createFakeRuntime } from "@outstaff/core/fakes";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createOfficeConnection } from "../office-client/index.js";
import { FakeSocket } from "../office-client/testing.js";
import { StartupError, prepareAgent } from "./startup.js";

const stockCatalogDir = fileURLToPath(new URL("../../../catalog", import.meta.url));

const TEAM = `
version: 1
team: { name: acme, product: Acme Shop }
humans:
  - { name: Ada Admin, identities: { chat: U1 } }
catalog: { version: 0.0.0 }
repos:
  - { name: shop, url: github.com/acme-example/shop, kind: primary }
people:
  - { handle: sam, name: Sam Duarte, pronouns: they/them, role: developer, repos: { shop: write } }
integrations:
  chat: { adapter: fake }
  vcs: { adapter: fake }
  runtime: { adapter: fake }
  tracker: { adapter: fake }
policies:
  commands:
    allow:
      - { program: acme-lint, reason: The team linter. }
`;

/** The fake adapters, with a runtime that wants skills in a Claude-style place. */
function registry() {
  const fakes = createFakeAdapterRegistry();
  const out = new AdapterRegistry();
  for (const def of fakes.list()) {
    if (def.port !== "runtime") {
      out.register(def);
    }
  }

  return out.register(
    defineAdapter({
      port: "runtime",
      name: "fake",
      capabilities: ["runtime.sessions", "runtime.usage"],
      options: z.looseObject({}),
      secrets: () => [],
      workdirLayout: (files) =>
        new Map([...files].map(([p, t]) => [p.replace(/^skills\//, ".agent/skills/"), t])),
      create: () => createFakeRuntime(),
    }),
  );
}

const TOOLS_TEAM = TEAM.replace(
  "policies:",
  `tools:
  go: { version: 1.23.4, allow: all }
  their-cli: { source: "ubi:vendor/their-cli", version: 0.9.1, allow: [status] }
policies:`,
);

function setup(extra: Record<string, string> = {}, team = TEAM) {
  const dir = mkdtempSync(join(tmpdir(), "ost-agent-"));
  mkdirSync(join(dir, "team", ".outstaff"), { recursive: true });
  writeFileSync(join(dir, "team", ".outstaff", "team.yaml"), team);
  const home = join(dir, "home");
  const connection = createOfficeConnection({
    url: "ws://office.test/agent",
    person: "sam",
    token: "t",
    agentVersion: "test",
    socket: () => new FakeSocket(),
  });

  const options = {
    env: {
      OUTSTAFF_PERSON: "sam",
      OUTSTAFF_OFFICE_URL: "ws://office.test/agent",
      OUTSTAFF_TEAM_FILE: join(dir, "team"),
      OUTSTAFF_SECRETS_DIR: join(dir, "none"),
      OUTSTAFF_AGENT_TOKEN: "tok",
      ...extra,
    },
    home,
    registry: registry(),
    stockCatalogDir,
    agentVersion: "test",
    connection,
    // The developer role's stock tools would otherwise run the real mise and change this process's PATH.
    tools: {
      mise: async () => ({ code: 0, stdout: "", stderr: "" }),
      addToPath: () => {},
    },
  };

  return { dir, home, options };
}

describe("prepareAgent", () => {
  it("renders the workdir through the runtime's layout and builds the policy and identity", async () => {
    const { home, options } = setup();
    const agent = await prepareAgent(options);

    const work = join(home, "work");
    expect(agent.workdir).toBe(work);
    expect(existsSync(join(work, ".agent/skills/developer/SKILL.md"))).toBe(true);
    expect(existsSync(join(work, "skills"))).toBe(false);
    expect(readFileSync(join(work, "references/ost.md"), "utf8")).toContain("ost");
    for (const d of ["repos", "worktrees", "scratch", "memory"]) {
      expect(existsSync(join(home, d))).toBe(true);
    }

    // The fake host grants sam nothing, so nothing is cloned.
    expect(agent.repos).toEqual([]);
    expect(existsSync(join(home, "repos/shop"))).toBe(false);

    expect(agent.systemPrompt).toContain("You are Sam Duarte (@sam, they/them), the Developer");
    expect(agent.policy.profile).toBe("code");
    expect(agent.policy.git.repos[join(home, "worktrees/shop")]).toBe("write");

    // Rules from the stock toolset and from the team's policies.commands reach the policy.
    const run = (command: string) =>
      evaluate(agent.policy, { kind: "shell", command, cwd: join(home, "worktrees/shop") });

    expect(run("pnpm test").effect).toBe("allow");
    expect(run("acme-lint src").effect).toBe("allow");
    expect(run("curl https://example.com").effect).toBe("deny");
  });

  it("starts a person without repository grants with no vcs port", async () => {
    const team = TEAM.replace(
      "integrations:",
      "  - { handle: leo, name: Leo Fischer, pronouns: he/him, role: designer }\nintegrations:",
    );

    const { options } = setup({ OUTSTAFF_PERSON: "leo" }, team);
    const fakeVcs = options.registry.get("vcs", "fake")!;
    const noVcs = new AdapterRegistry();
    for (const def of options.registry.list()) {
      noVcs.register(
        def.port === "vcs"
          ? defineAdapter({
              ...fakeVcs,
              unavailableFor: ({ team: t, person }) =>
                repoAccess(t, person) === "none"
                  ? `${person.handle} has no GitHub identity`
                  : undefined,
            })
          : def,
      );
    }

    const agent = await prepareAgent({ ...options, registry: noVcs });
    expect(agent.repos).toEqual([]);
    expect(agent.systemPrompt).toContain("Leo Fischer");
    expect(agent.policy.git.repos).toEqual({});
  });

  it("explains a missing person or an unknown one", async () => {
    const { options } = setup();
    await expect(
      prepareAgent({ ...options, env: { ...options.env, OUTSTAFF_PERSON: "" } }),
    ).rejects.toThrow("OUTSTAFF_PERSON is not set.");

    await expect(
      prepareAgent({ ...options, env: { ...options.env, OUTSTAFF_PERSON: "ghost" } }),
    ).rejects.toThrow(StartupError);
  });

  it("needs the office url and the agent token to connect", async () => {
    const { options } = setup();
    const { connection: _c, ...rest } = options;
    await expect(
      prepareAgent({ ...rest, env: { ...options.env, OUTSTAFF_OFFICE_URL: "" } }),
    ).rejects.toThrow("OUTSTAFF_OFFICE_URL is not set.");

    await expect(
      prepareAgent({ ...rest, env: { ...options.env, OUTSTAFF_AGENT_TOKEN: "" } }),
    ).rejects.toThrow("Missing secret OUTSTAFF_AGENT_TOKEN.");
  });

  it("fails clearly when the runtime adapter is not installed", async () => {
    const { options } = setup();
    await expect(prepareAgent({ ...options, registry: new AdapterRegistry() })).rejects.toThrow(
      'runtime adapter "fake" is not installed',
    );
  });

  it("installs the declared tools and allows exactly their declared verbs", async () => {
    const { home, options } = setup({}, TOOLS_TEAM);
    const calls: string[][] = [];
    const paths: string[] = [];
    const agent = await prepareAgent({
      ...options,
      tools: {
        mise: async (args) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
        addToPath: (dir) => paths.push(dir),
      },
    });

    expect(calls).toEqual([["lock"], ["install"]]);
    expect(paths).toEqual([join(home, ".local/share/mise/shims")]);
    // The team's go replaces the code toolset's; the toolset's other tools stay.
    expect(agent.tools.map((t) => [t.name, t.version])).toEqual([
      ["go", "1.23.4"],
      ["pnpm", "12.9.1"],
      ["python", "3.13.9"],
      ["their-cli", "0.9.1"],
      ["yarn", "1.22.22"],
    ]);

    expect(agent.tools.every((t) => t.state === "installed")).toBe(true);

    const run = (command: string) =>
      evaluate(agent.policy, { kind: "shell", command, cwd: join(home, "worktrees/shop") });

    expect(run("go test ./...").effect).toBe("allow");
    expect(run("their-cli status").effect).toBe("allow");
    expect(run("their-cli deploy").effect).toBe("ask");
  });

  it("starts anyway when a tool cannot be installed and says which", async () => {
    const { options } = setup({}, TOOLS_TEAM);
    const logged: string[] = [];
    const agent = await prepareAgent({
      ...options,
      log: { debug() {}, info() {}, warn() {}, error: (m) => logged.push(m) },
      tools: {
        mise: async () => ({
          code: 127,
          stdout: "",
          stderr: "mise is not installed in this image.",
        }),
        addToPath: () => {},
      },
    });

    expect(agent.tools.every((t) => t.state === "unavailable")).toBe(true);
    expect(logged.some((m) => m.includes("go@1.23.4 is unavailable"))).toBe(true);
    expect(agent.env.tools).toBe(agent.tools);
  });

  it("does not run mise when no tool is declared", async () => {
    const { options } = setup({}, TEAM.replace("role: developer", "role: reviewer"));
    const agent = await prepareAgent({
      ...options,
      tools: {
        mise: async () => {
          throw new Error("mise must not run");
        },
      },
    });

    expect(agent.tools).toEqual([]);
  });
});
