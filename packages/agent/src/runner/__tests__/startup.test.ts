import { cpSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdapterRegistry,
  defineAdapter,
  evaluate,
  loadTeamConfig,
  repoAccess,
} from "@outstaff/core";
import { createFakeAdapterRegistry, createFakeRuntime } from "@outstaff/core/fakes";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createManualClock, officeWithTeam } from "#/office-client/__tests__/testing.js";
import { withGlobalConfig } from "#/tools/mise-current.js";
import { StartupError } from "#/runner/startup-error.js";
import { prepareAgent } from "#/runner/startup.js";

const stockCatalogDir = fileURLToPath(new URL("../../../../catalog", import.meta.url));

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
      capabilities: ["runtime.sessions", "runtime.usage", "runtime.permissions", "design.canvas"],
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
  const home = join(dir, "home");
  const connection = officeWithTeam(team, extra["OUTSTAFF_PERSON"] ?? "sam").connect();

  const options = {
    env: {
      OUTSTAFF_PERSON: "sam",
      OUTSTAFF_OFFICE_URL: "ws://office.test/agent",
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
      mise: withGlobalConfig(async () => ({ code: 0, stdout: "", stderr: "" })),
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
    expect(run("curl https://example.com").effect).toBe("allow");
    expect(
      run(`cat ${options.env["OUTSTAFF_SECRETS_DIR"] ?? "/run/secrets/outstaff"}/X`).effect,
    ).toBe("deny");
  });

  it("grants a person the network of their role and their own, and scrubs the token from the shell", async () => {
    const granted = TEAM.replace(
      "people:",
      `roles:
  developer:
    network:
      http: [{ name: hub, url: "https://hub.acme.example" }]
people:`,
    ).replace(
      "role: developer, repos: { shop: write } }",
      `role: developer, repos: { shop: write }, network: { http: [{ name: home, url: "https://home.acme.example", token: HOME_TOKEN }] } }`,
    );

    const { home, options } = setup({ HOME_TOKEN: "home-token-value-123" }, granted);
    let scrub: readonly string[] | undefined;
    options.registry = new AdapterRegistry();
    for (const def of registry().list()) {
      options.registry.register(
        def.port === "runtime"
          ? defineAdapter({
              port: "runtime",
              name: "fake",
              capabilities: ["runtime.sessions", "runtime.usage", "runtime.permissions"],
              options: z.looseObject({}),
              secrets: () => [],
              create: (ctx) => {
                scrub = ctx.secretKeys;
                return createFakeRuntime();
              },
            })
          : def,
      );
    }

    const agent = await prepareAgent(options);
    expect(scrub).toContain("HOME_TOKEN");
    expect(agent.env.network?.http.map((h) => h.name).toSorted()).toEqual(["home", "hub"]);
    expect(agent.env.network?.http.find((h) => h.name === "home")?.token?.()).toBe(
      "home-token-value-123",
    );

    const cwd = join(home, "worktrees/shop");
    const run = (command: string) => evaluate(agent.policy, { kind: "shell", command, cwd });
    // The grants feed the verbs; the shell reaches the network directly, as the deployment's network policy allows.
    expect(run("curl -s https://hub.acme.example/status").effect).toBe("allow");
  });

  it("prepares a sweeper that removes the scratch folders of items the person no longer has", async () => {
    const { home, options } = setup();
    for (const id of ["ACME-12", "ACME-20"]) {
      mkdirSync(join(home, "scratch", id), { recursive: true });
    }

    const asked: string[][] = [];
    options.connection.workStatus = async (ids) => {
      asked.push(ids);

      return ids.map((workItemId) => ({
        workItemId,
        state: workItemId === "ACME-12" ? "done" : "blocked",
      }));
    };

    const agent = await prepareAgent(options);

    expect(await agent.sweeper.sweep()).toEqual(["ACME-12"]);
    expect(asked).toEqual([["ACME-12", "ACME-20"]]);
    expect(existsSync(join(home, "scratch/ACME-12"))).toBe(false);
    expect(existsSync(join(home, "scratch/ACME-20"))).toBe(true);
  });

  it("sweeps on the interval and clock it is given", async () => {
    const { home, options } = setup();
    mkdirSync(join(home, "scratch", "ACME-12"), { recursive: true });
    const clock = createManualClock();
    const asked: string[][] = [];
    options.connection.workStatus = async (ids) => {
      asked.push(ids);

      return ids.map((workItemId) => ({ workItemId, state: "done" as const }));
    };

    // The office is connected: answer the journal note of a done item at once instead of waiting for the office.
    options.connection.journal = async () => {};
    const agent = await prepareAgent({ ...options, clock, sweepEveryMs: 1000 });
    agent.sweeper.start();
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    mkdirSync(join(home, "scratch", "ACME-13"), { recursive: true });
    clock.advance(1000);
    await vi.waitFor(() => expect(asked).toEqual([["ACME-12"], ["ACME-13"]]));
    agent.sweeper.stop();
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

  describe("Design canvas", () => {
    const withLeo = (team = TEAM) =>
      team.replace(
        "integrations:",
        "  - { handle: leo, name: Leo Fischer, pronouns: he/him, role: designer }\nintegrations:",
      );

    it("gives the designer the artifact tool and a persistent artifacts folder", async () => {
      const { home, options } = setup({ OUTSTAFF_PERSON: "leo" }, withLeo());
      const agent = await prepareAgent(options);
      expect(agent.policy.tools.allow).toContain("artifact");
      expect(existsSync(join(home, "artifacts"))).toBe(true);
      expect(
        evaluate(agent.policy, { kind: "write", path: join(home, "artifacts/home.html") }).effect,
      ).toBe("allow");
    });

    it("leaves it out when the team switches design.canvas off", async () => {
      const team = withLeo().replace("policies:", "policies:\n  design: { canvas: false }");
      const { home, options } = setup({ OUTSTAFF_PERSON: "leo" }, team);
      const agent = await prepareAgent(options);
      expect(agent.policy.tools.allow).not.toContain("artifact");
      expect(existsSync(join(home, "artifacts"))).toBe(false);
    });

    it("leaves it out for the developer", async () => {
      const { home, options } = setup();
      const agent = await prepareAgent(options);
      expect(agent.policy.tools.allow).not.toContain("artifact");
      expect(existsSync(join(home, "artifacts"))).toBe(false);
    });
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
      'sam runs on the runtime adapter "fake", which is not installed in this build (it carries: none).',
    );
  });

  it("installs the declared tools and narrows a tool to its declared verbs", async () => {
    const { home, options } = setup({}, TOOLS_TEAM);
    const calls: string[][] = [];
    const paths: string[] = [];
    const agent = await prepareAgent({
      ...options,
      tools: {
        mise: (args, o) => {
          calls.push(args);
          return withGlobalConfig(async () => ({ code: 0, stdout: "", stderr: "" }))(args, o);
        },
        addToPath: (dir) => paths.push(dir),
      },
    });

    expect(calls.filter((c) => c[0] === "lock" || c[0] === "install")).toEqual([
      ["lock"],
      ["install"],
    ]);

    // Every tool is asked for once more, outside the generated config, as a shim would be.
    expect(calls.filter((c) => c[0] === "current").map((c) => c[1])).toEqual([
      "go",
      "pnpm",
      "python",
      "ubi:vendor/their-cli",
      "yarn",
    ]);

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
    expect(run("their-cli deploy").rule).toBe("commands.narrowed");
  });

  it("fails to start, naming the tool, when one cannot be installed", async () => {
    const { options } = setup({}, TOOLS_TEAM);
    const error = await prepareAgent({
      ...options,
      tools: {
        mise: async () => ({
          code: 127,
          stdout: "",
          stderr: "mise is not installed in this image.",
        }),
        addToPath: () => {},
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StartupError);
    expect((error as Error).message).toContain("go@1.23.4 could not be installed");
    expect((error as Error).message).toContain("pnpm@12.9.1 could not be installed");
  });

  it("fails to start when an installed tool does not resolve", async () => {
    const { options } = setup({}, TOOLS_TEAM);
    const error = await prepareAgent({
      ...options,
      tools: {
        mise: withGlobalConfig(async (args) =>
          args[0] === "where" && args[1] === "pnpm@12.9.1"
            ? { code: 1, stdout: "", stderr: "mise ERROR pnpm@12.9.1 is not installed" }
            : { code: 0, stdout: "", stderr: "" },
        ),
        addToPath: () => {},
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StartupError);
    expect((error as Error).message).toContain(
      "pnpm@12.9.1 does not resolve: pnpm@12.9.1 is not installed",
    );

    expect((error as Error).message).not.toContain("go@");
  });

  it("installs python for a role on the base toolset, such as the designer", async () => {
    const { options } = setup({}, TEAM.replace("role: developer", "role: designer"));
    const agent = await prepareAgent({
      ...options,
      tools: {
        mise: withGlobalConfig(async () => ({ code: 0, stdout: "", stderr: "" })),
        addToPath: () => {},
      },
    });

    expect(agent.tools.map((t) => [t.name, t.version])).toEqual([["python", "3.13.9"]]);
  });

  it("takes the ejected catalog from the team folder of the image, not from the office", async () => {
    const teamDir = mkdtempSync(join(tmpdir(), "team-"));
    const role = join(teamDir, "catalog", "roles", "auditor");
    mkdirSync(role, { recursive: true });
    writeFileSync(
      join(role, "role.yaml"),
      "name: auditor\ntitle: Auditor\nsummary: Checks the books.\ntoolset: base\npermissions: readonly\n",
    );

    writeFileSync(join(role, "SKILL.md"), "# Auditor of {{ team.name }}\n");
    const { home, options } = setup({}, TEAM.replace("role: developer", "role: auditor"));
    const agent = await prepareAgent({ ...options, teamDir });
    expect(readFileSync(join(home, "work/.agent/skills/auditor/SKILL.md"), "utf8")).toContain(
      "# Auditor of acme",
    );

    expect(agent.systemPrompt).toContain("the Auditor");
  });

  it("writes the team from the office for its child processes and points OUTSTAFF_TEAM_FILE at it", async () => {
    const { home, options } = setup();
    await prepareAgent({ ...options, teamDir: "/opt/acme/.outstaff" });
    const file = join(home, ".config/outstaff/team.json");
    expect((options.env as NodeJS.ProcessEnv)["OUTSTAFF_TEAM_FILE"]).toBe(file);

    // What `ost git-credential` and the `ost` verbs load.
    const loaded = await loadTeamConfig({ env: options.env });
    expect(loaded.ok && loaded.config.people.map((p) => p.handle)).toEqual(["sam"]);
    expect(loaded.ok && loaded.config.catalog.path).toBe("/opt/acme/.outstaff/catalog");
  });

  it("refuses a team from the office that does not validate", async () => {
    const { options } = setup({}, "version: 1\nteam: { name: acme }\n");
    await expect(prepareAgent(options)).rejects.toThrow(
      /^The team config from the office is invalid:\n(.|\n)*catalog/,
    );
  });

  it("does not run mise when no tool is declared", async () => {
    // A catalog whose base toolset is gone leaves the reviewer with no tool at all.
    const catalog = mkdtempSync(join(tmpdir(), "catalog-"));
    cpSync(stockCatalogDir, catalog, {
      recursive: true,
      filter: (src) =>
        !src.endsWith(join("toolsets", "base.yaml")) && !src.includes("node_modules"),
    });

    const { options } = setup({}, TEAM.replace("role: developer", "role: reviewer"));
    const agent = await prepareAgent({
      ...options,
      stockCatalogDir: catalog,
      tools: {
        mise: async () => {
          throw new Error("mise must not run");
        },
      },
    });

    expect(agent.tools).toEqual([]);
  });
});
