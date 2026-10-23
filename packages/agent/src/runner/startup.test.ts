import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterRegistry, defineAdapter, evaluate } from "@outstaff/core";
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

function setup(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ost-agent-"));
  mkdirSync(join(dir, "team", ".outstaff"), { recursive: true });
  writeFileSync(join(dir, "team", ".outstaff", "team.yaml"), TEAM);
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
});
