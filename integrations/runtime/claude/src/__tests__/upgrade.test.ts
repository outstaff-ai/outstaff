import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  buildPolicy,
  loadCatalog,
  loadTeamConfig,
  renderPerson,
  type RuntimeEvent,
  type RuntimeTool,
} from "@outstaff/core";
import { sampleRunRequest } from "@outstaff/core/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { workdirFiles } from "../layout.js";
import { agentSdkOptions } from "../options.js";
import { createAgentSdkRuntime } from "../runtime.js";
import type { QueryFn } from "../types.js";

// Guards against SDK or Claude Code upgrades that change what loads in an unattended run. It runs real sessions with
// the cheapest model against a workdir rendered the way the agent renders it, so it costs a few cents.
// Run with OUTSTAFF_TEST_LIVE_SDK=1 (uses whatever Claude credentials the environment has); CI runs it in the
// `runtime-upgrade` job. See the README of this package.
const live = process.env["OUTSTAFF_TEST_LIVE_SDK"] === "1";
if (!live) {
  console.warn(
    "upgrade.test.ts skipped: set OUTSTAFF_TEST_LIVE_SDK=1 to run the live SDK upgrade test.",
  );
}

/**
 * Skills that Claude Code lists in `init` even with `disableBundledSkills`. They come from its built-in plugins
 * (`plugins` in `init`, path "builtin") and cannot be removed by a setting. The runtime's `skills` allowlist still
 * makes the Skill tool reject them, which the test checks. Seen in Claude Code 2.1.308. A new name fails the test
 * so an upgrade that adds a skill gets a human decision.
 */
const UNAVOIDABLE_BUILTIN_SKILLS: readonly string[] = ["design", "doctor", "plugin-authoring"];

const stockCatalogDir = fileURLToPath(new URL("../../../../../packages/catalog", import.meta.url));
const teamDir = fileURLToPath(new URL("../../../../../examples/acme", import.meta.url));
const PERSON = "sam";
const PERSON_ROLE = "developer";
const NONCE = "ost-nonce-4f9c1e";
const ALLOWED_TOKEN = "ALLOWED-CONTENT-7731";
const BLOCKED_TOKEN = "BLOCKED-CONTENT-5528";
const ENV_TOKEN = "DOTENV-CONTENT-2290";

const root = live ? mkdtempSync(join(tmpdir(), "ost-upgrade-")) : "";
const home = join(root, "home");
const workdir = join(home, "work");
afterAll(() => root && rmSync(root, { recursive: true, force: true }));

let renderedSkills: string[] = [];
let otherRoleSkills: string[] = [];
let profile: Parameters<typeof buildPolicy>[0]["profile"] = "code";
let team: Awaited<ReturnType<typeof loadTeamConfig>> extends infer R
  ? R extends { ok: true; config: infer C }
    ? C
    : never
  : never;

const layout = () => ({
  home,
  workDir: workdir,
  reposDir: join(home, "repos"),
  worktreesDir: join(home, "worktrees"),
  scratchDir: join(home, "scratch"),
  memoryDir: join(home, "memory"),
  secretsDir: join(root, "secrets"),
});

/** The runtime on the real SDK, recording every raw message of the session. */
function recordingRuntime() {
  const messages: SDKMessage[] = [];
  const query: QueryFn = (params) => {
    const stream = sdkQuery(params);
    return (async function* () {
      for await (const m of stream) {
        messages.push(m);
        yield m;
      }
    })();
  };

  // No `env` override: the process environment (and so its Claude credentials) is the starting point, as in production.
  const runtime = createAgentSdkRuntime({
    options: agentSdkOptions.parse({ model: "haiku", maxTurns: 6 }),
    query,
  });

  return { runtime, messages };
}

type Rec = Record<string, unknown>;
const init = (messages: SDKMessage[]) =>
  messages.find(
    (m) => m.type === "system" && (m as unknown as Rec)["subtype"] === "init",
  ) as unknown as Rec;

/** Text of every tool result of the session. */
function toolResults(messages: SDKMessage[]): string {
  return messages
    .filter((m) => m.type === "user")
    .map((m) => JSON.stringify((m as unknown as Rec)["message"]))
    .join("\n");
}

async function session(
  prompt: string,
  overrides: Partial<Parameters<typeof sampleRunRequest>[0]> = {},
) {
  const { runtime, messages } = recordingRuntime();
  const policy = buildPolicy({ profile, person: person(), team, layout: layout() });
  const events: RuntimeEvent[] = [];
  for await (const e of runtime.run(
    sampleRunRequest({
      prompt,
      workdir,
      policy,
      systemPrompt: "You are a test agent. Do exactly what the user asks, using the tools named.",
      builtinTools: ["read", "search"],
      addDirs: [layout().scratchDir],
      maxTurns: 6,
      ...overrides,
    }),
  )) {
    events.push(e);
  }

  return { events, messages };
}

const person = () => team.people.find((p) => p.handle === PERSON)!;

describe.skipIf(!live)("Claude Agent SDK upgrade check (OUTSTAFF_TEST_LIVE_SDK=1)", () => {
  beforeAll(async () => {
    const loaded = await loadTeamConfig({ env: { OUTSTAFF_TEAM_FILE: teamDir } });
    if (!loaded.ok) {
      throw new Error("The acme example team does not load.");
    }

    team = loaded.config;
    const catalog = loadCatalog(stockCatalogDir);
    const rendered = renderPerson({ team, handle: PERSON, catalog });
    profile = rendered.profile;

    // The same steps as agent startup: lay the files out for the runtime, write them below the working directory.
    const files = workdirFiles(rendered.files);
    for (const [path, text] of files) {
      const target = join(workdir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }

    renderedSkills = [...files.keys()]
      .map((p) => /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(p)?.[1])
      .filter((s): s is string => s !== undefined);

    otherRoleSkills = Object.keys(catalog.roles).filter((r) => !renderedSkills.includes(r));

    // Settings as the project's own `.claude/settings.json`: a deny rule the hook alone would not produce.
    // The files live in the scratch directory, which the policy lets the person read (`//` is an absolute path).
    const scratch = layout().scratchDir;
    writeFileSync(
      join(workdir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: [`Read(/${scratch}/blocked.txt)`] } }),
    );

    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "allowed.txt"), ALLOWED_TOKEN);
    writeFileSync(join(scratch, "blocked.txt"), BLOCKED_TOKEN);
    writeFileSync(join(scratch, ".env"), ENV_TOKEN);
  });

  it(
    "loads the person's skills, no other roles' and no unlisted built-ins",
    { timeout: 180_000 },
    async () => {
      const { events, messages } = await session("Reply with the word ok and nothing else.", {
        builtinTools: [],
        maxTurns: 3,
      });

      expect(events.find((e) => e.type === "finished")).toMatchObject({ ok: true });
      const i = init(messages);
      const skills = i["skills"] as string[];
      // A rendered SKILL.md has no front matter yet, so Claude Code lists it as a command but not in `skills`.
      const commands = i["slash_commands"] as string[];
      console.info("init skills:", JSON.stringify(skills));

      expect(renderedSkills.length).toBeGreaterThan(0);
      for (const s of renderedSkills) {
        expect(commands).toContain(s);
      }

      for (const s of otherRoleSkills) {
        expect(skills).not.toContain(s);
        expect(commands).not.toContain(s);
      }

      const unexpected = skills.filter(
        (s) => !renderedSkills.includes(s) && !UNAVOIDABLE_BUILTIN_SKILLS.includes(s),
      );

      expect(unexpected, "skills outside the rendered ones and the documented built-ins").toEqual(
        [],
      );
    },
  );

  it("runs a rendered skill and rejects a built-in one", { timeout: 180_000 }, async () => {
    const { messages } = await session(
      `Call the Skill tool with skill "${PERSON_ROLE}", then call the Skill tool with skill "dataviz", ` +
        'then call the Skill tool with skill "doctor". Then say done.',
      { builtinTools: [] },
    );

    const results = toolResults(messages);
    expect(results).toContain(`Launching skill: ${PERSON_ROLE}`);
    expect(results).not.toContain("Launching skill: dataviz");
    expect(results).not.toContain("Launching skill: doctor");
  });

  it(
    "applies a settings deny rule and lets the hook judge every call",
    { timeout: 180_000 },
    async () => {
      const { events, messages } = await session(
        `Use the Read tool on each of these files, one call per file, in this order: ${layout().scratchDir}/allowed.txt, ` +
          `${layout().scratchDir}/blocked.txt, ${layout().scratchDir}/.env. ` +
          "Then say done. Do not use any other tool.",
      );

      const calls = events.filter(
        (e): e is Extract<RuntimeEvent, { type: "tool_call" }> => e.type === "tool_call",
      );

      const read = (name: string) =>
        calls.find((c) => c.tool === "Read" && JSON.stringify(c.input).includes(name));

      // The hook sees the call; the policy allows an ordinary file and denies a secret one.
      expect(read("allowed.txt")?.decision.effect).toBe("allow");
      expect(read(".env")?.decision.effect).toBe("deny");

      // The settings rule denies a file the policy allows. Claude Code may refuse it before the hook runs, so the
      // hook's verdict on it is not asserted; the content must not reach the model either way.
      const blocked = read("blocked.txt");
      expect(blocked === undefined || blocked.decision.effect === "allow").toBe(true);

      const results = toolResults(messages);
      expect(results).toContain(ALLOWED_TOKEN);
      expect(results).not.toContain(BLOCKED_TOKEN);
      expect(results).not.toContain(ENV_TOKEN);

      const result = messages.find((m) => m.type === "result") as unknown as Rec;
      expect(JSON.stringify(result["permission_denials"])).toContain("blocked.txt");
    },
  );

  it("calls an in-process ost tool", { timeout: 180_000 }, async () => {
    let handled: unknown;
    const ping: RuntimeTool = {
      name: "ping",
      description: "Returns a one-time code. Call it with a message.",
      input: z.object({ message: z.string() }),
      handler: async (input) => {
        handled = input;
        return NONCE;
      },
    };

    const { events, messages } = await session(
      "Call the ping tool with the message hello, then reply with the code it returns.",
      { tools: [ping], builtinTools: [] },
    );

    expect(handled).toMatchObject({ message: "hello" });
    expect(events.some((e) => e.type === "tool_call" && e.tool === "mcp__ost__ping")).toBe(true);

    expect(JSON.stringify(init(messages)["mcp_servers"])).toContain("ost");
    const finished = events.find((e) => e.type === "finished");
    expect(finished).toMatchObject({ ok: true });
    expect((finished as { text: string }).text).toContain(NONCE);
  });

  it(
    "loads no account connectors, plugins or other MCP servers",
    { timeout: 180_000 },
    async () => {
      const { messages } = await session("Reply with the word ok and nothing else.", {
        builtinTools: [],
        maxTurns: 3,
      });

      const i = init(messages);
      const servers = (i["mcp_servers"] as { name: string }[]).map((s) => s.name);
      console.info(
        "init mcp_servers:",
        JSON.stringify(servers),
        "plugins:",
        JSON.stringify(i["plugins"]),
      );

      expect(servers).toEqual(["ost"]);

      // Only plugins built into Claude Code; nothing from the account or the machine.
      expect((i["plugins"] as { path: string }[]).filter((p) => p.path !== "builtin")).toEqual([]);
      expect(
        (i["tools"] as string[]).filter(
          (t) => t.startsWith("mcp__") && !t.startsWith("mcp__ost__"),
        ),
      ).toEqual([]);
    },
  );
});
