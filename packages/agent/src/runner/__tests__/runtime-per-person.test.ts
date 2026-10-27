import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdapterRegistry,
  defineAdapter,
  evaluate,
  type Capability,
  type Logger,
} from "@outstaff/core";
import { createFakeAdapterRegistry, createFakeRuntime } from "@outstaff/core/fakes";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { officeWithTeam } from "#/office-client/__tests__/testing.js";
import { withGlobalConfig } from "#/tools/mise-current.js";
import { installedRuntimes } from "#/runner/runtime-select.js";
import { prepareAgent } from "#/runner/startup.js";

const stockCatalogDir = fileURLToPath(new URL("../../../../catalog", import.meta.url));

// The team runs on the fake runtime; sam and leo each pick a runtime of their own, noor keeps the team's.
const TEAM = `
version: 1
team: { name: acme }
humans:
  - { name: Ada Admin, identities: { chat: U1 } }
catalog: { version: 0.0.0 }
repos:
  - { name: shop, url: github.com/acme-example/shop, kind: primary }
people:
  - { handle: sam, name: Sam Duarte, role: developer, model: acme-large, runtime: { adapter: acme-alt, tier: fast } }
  - { handle: noor, name: Noor Haddad, role: developer, model: acme-small }
  - { handle: leo, name: Leo Fischer, role: designer, runtime: { adapter: acme-alt } }
  - { handle: kofi, name: Kofi Mensah, role: developer, runtime: { adapter: acme-loose } }
integrations:
  chat: { adapter: fake }
  vcs: { adapter: fake }
  runtime: { adapter: fake }
  tracker: { adapter: fake }
`;

interface Created {
  adapter: string;
  options: unknown;
}

/** A second, minimal runtime that only tests have: it records what it was created with. */
function stubRuntime(name: string, capabilities: Capability[], created: Created[]) {
  return defineAdapter({
    port: "runtime",
    name,
    capabilities,
    options: z.strictObject({ tier: z.enum(["fast"]).optional() }),
    secrets: () => [],
    workdirLayout: (files) =>
      new Map([...files].map(([p, t]) => [p.replace(/^skills\//, `.${name}/skills/`), t])),
    permissions: () => [
      { id: `${name}.deny`, program: "acme-danger", effect: "deny", reason: `${name} forbids it.` },
    ],
    create: (ctx) => {
      created.push({ adapter: name, options: ctx.options });
      return createFakeRuntime();
    },
  });
}

function setup(person: string) {
  const dir = mkdtempSync(join(tmpdir(), "ost-runtime-"));
  const home = join(dir, "home");
  const created: Created[] = [];
  const registry = new AdapterRegistry();
  for (const def of createFakeAdapterRegistry().list()) {
    registry.register(def);
  }

  registry
    .register(
      stubRuntime(
        "acme-alt",
        ["runtime.sessions", "runtime.usage", "runtime.permissions"],
        created,
      ),
    )
    .register(stubRuntime("acme-loose", ["runtime.sessions"], created));

  const lines: [string, Record<string, unknown> | undefined][] = [];
  const log: Logger = {
    debug: () => {},
    info: (message, data) => lines.push([message, data]),
    warn: () => {},
    error: () => {},
  };

  const options = {
    env: {
      OUTSTAFF_PERSON: person,
      OUTSTAFF_OFFICE_URL: "ws://office.test/agent",
      OUTSTAFF_SECRETS_DIR: join(dir, "none"),
      OUTSTAFF_AGENT_TOKEN: "tok",
    },
    home,
    registry,
    stockCatalogDir,
    agentVersion: "test",
    log,
    connection: officeWithTeam(TEAM, person).connect(),
    tools: {
      mise: withGlobalConfig(async () => ({ code: 0, stdout: "", stderr: "" })),
      addToPath: () => {},
    },
  };

  return { home, options, created, lines, registry };
}

const deny = (agent: Awaited<ReturnType<typeof prepareAgent>>) =>
  evaluate(agent.policy, { kind: "shell", command: "acme-danger now", cwd: "/tmp" }).effect;

describe("a runtime per person", () => {
  it("starts a person on their own runtime, with its options, layout, rules and their model", async () => {
    const { home, options, created, lines } = setup("sam");
    const agent = await prepareAgent(options);

    expect(created.map((c) => [c.adapter, c.options])).toEqual([["acme-alt", { tier: "fast" }]]);
    expect(agent.team.integrations.runtime).toEqual({ adapter: "acme-alt", tier: "fast" });
    expect(existsSync(join(home, "work/.acme-alt/skills/developer/SKILL.md"))).toBe(true);
    expect(deny(agent)).toBe("deny");
    expect(lines).toContainEqual([
      "runtime selected",
      { person: "sam", runtime: "acme-alt", model: "acme-large" },
    ]);
  });

  it("starts a person without a runtime of their own on the team's", async () => {
    const { options, created, lines } = setup("noor");
    const agent = await prepareAgent(options);

    expect(created).toEqual([]);
    expect(agent.team.integrations.runtime).toEqual({ adapter: "fake" });
    expect(deny(agent)).not.toBe("deny");
    expect(lines).toContainEqual([
      "runtime selected",
      { person: "noor", runtime: "fake", model: "acme-small" },
    ]);
  });

  it("keeps the canvas off for a designer whose runtime does not provide it", async () => {
    const { home, options } = setup("leo");
    const agent = await prepareAgent(options);
    expect(agent.policy.tools.allow).not.toContain("artifact");
    expect(existsSync(join(home, "artifacts"))).toBe(false);
  });

  it("refuses a runtime that cannot enforce the permission policy", async () => {
    const { options } = setup("kofi");
    await expect(prepareAgent(options)).rejects.toThrow(
      'kofi runs on the runtime adapter "acme-loose", which cannot enforce a permission policy (runtime.permissions).',
    );
  });

  it("names the runtimes a build carries when a person's is missing", async () => {
    const { options, registry } = setup("sam");
    const without = new AdapterRegistry();
    for (const def of registry.list()) {
      if (def.name !== "acme-alt") {
        without.register(def);
      }
    }

    expect(installedRuntimes(without)).toEqual(["fake", "acme-loose"]);
    await expect(prepareAgent({ ...options, registry: without })).rejects.toThrow(
      'sam runs on the runtime adapter "acme-alt", which is not installed in this build (it carries: fake, acme-loose).',
    );
  });
});
