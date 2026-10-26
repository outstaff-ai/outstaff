import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACME_TEAM_FILE,
  DUPLICATE_HANDLE_TEAM,
  MISSING_REPOS_TEAM,
  UNKNOWN_REPO_GRANT_TEAM,
  YAML_SYNTAX_ERROR_TEAM,
} from "../../core/src/testing/fixtures.js";
import { renderCliReference } from "./reference.js";
import type { Context } from "./define.js";
import { run, version } from "./program.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ost-cli-")));
let n = 0;

function project(name = `p${n++}`, team?: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, ".outstaff"), { recursive: true });
  if (team !== undefined) {
    writeFileSync(join(dir, ".outstaff", "team.yaml"), team);
  }

  return dir;
}

const roleFiles = (name: string) => ({
  [`roles/${name}/role.yaml`]: `name: ${name}\ntitle: ${name}\nsummary: s\ntoolset: base\npermissions: docs\n`,
  [`roles/${name}/SKILL.md`]: `Skill of ${name} at {{team.name}}.\n`,
});

/** Writes a catalog from {relative path: text}. */
function catalogDir(name: string, files: Record<string, string>, withVersion = true) {
  const dir = join(root, name);
  for (const [rel, text] of Object.entries({
    ...(withVersion ? { "package.json": '{"version":"0.0.0"}' } : {}),
    ...files,
  })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }

  return dir;
}

/** A stock catalog with the roles the acme team uses; a stand-in so the tests do not depend on the shipped text. */
const ACME_ROLES = ["pm", "product", "architect", "designer", "developer", "reviewer", "devops"];
const stockFixture = catalogDir(
  "stock",
  Object.assign({}, ...ACME_ROLES.map(roleFiles), {
    "references/style.md": "Style at {{team.name}}.\n",
  }),
);

async function ost(
  cwd: string,
  args: string[],
  origin?: string,
  stockCatalogDir: string | undefined = stockFixture,
) {
  let out = "";
  let err = "";
  const ctx: Context = {
    cwd,
    env: {},
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    gitOrigin: () => origin,
    ...(stockCatalogDir ? { stockCatalogDir } : {}),
  };

  const code = await run(args, ctx);
  return { code, out: out.replaceAll(root, "<tmp>"), err: err.replaceAll(root, "<tmp>") };
}

const acme = () => project(undefined, readFileSync(ACME_TEAM_FILE, "utf8"));

describe("ost --version", () => {
  it("prints the package version", async () => {
    expect(await ost(root, ["--version"])).toMatchObject({ code: 0, out: `${version}\n` });
  });
});

describe("ost validate", () => {
  // Without `humans` and with a person who has no grants, validation warns but still passes.
  const warned = () =>
    project(
      undefined,
      readFileSync(ACME_TEAM_FILE, "utf8")
        .replace(/humans:[\s\S]*?\ncatalog:/, "catalog:")
        .replace(
          '    repos:\n      "*": read\n  - handle: kofi',
          "    repos: {}\n  - handle: kofi",
        ),
    );

  it("accepts the acme team cleanly", async () => {
    const r = await ost(acme(), ["validate"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatchSnapshot();
  });

  // One case per shipped adapter: acme configures all of them.
  it.each([
    ["chat", "slack"],
    ["vcs", "github"],
    ["runtime", "claude-agent-sdk"],
    ["tracker", "itsaplan"],
    ["knowledge", "itsaplan"],
    ["avatars", "dicebear"],
  ])("rejects an option %s/%s does not know, at its line", async (port, adapter) => {
    const team = readFileSync(ACME_TEAM_FILE, "utf8").replace(
      new RegExp(`(\\n  ${port}:\\n    adapter: ${adapter}\\n)`),
      "$1    bogus_option: true\n",
    );

    const r = await ost(project(`bogus-${port}`, team), ["validate", "--json"]);
    expect(r.code).toBe(1);
    const line = team.split("\n").findIndex((l) => l.includes("bogus_option")) + 1;
    expect(JSON.parse(r.out).errors).toEqual([
      expect.objectContaining({
        code: "integrations.invalid_options",
        path: ["integrations", port, "bogus_option"],
        line,
      }),
    ]);
  });

  it("lists warnings with their consequence and still exits 0", async () => {
    const r = await ost(warned(), ["validate"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Consequence:");
    expect(r.out).toMatchSnapshot();
  });

  it("prints a JSON report", async () => {
    const r = await ost(warned(), ["validate", "--json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report).toMatchObject({ ok: true, errors: [] });
    expect(report.warnings.find((w: { code: string }) => w.code === "trust.default")).toMatchObject(
      { code: "trust.default", line: expect.any(Number), consequence: expect.any(String) },
    );

    expect(r.out).toMatchSnapshot();
  });

  it("warns about a malformed chat identity with its file and line", async () => {
    const team = readFileSync(ACME_TEAM_FILE, "utf8");
    const chat = /chat: (U[A-Z0-9]+)/.exec(team)?.[1];
    expect(chat).toBeDefined();
    const r = await ost(project(undefined, team.replace(`chat: ${chat}`, "chat: alex")), [
      "validate",
    ]);

    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /^warning {2}\.outstaff\/team\.yaml:\d+:\d+ identities\.chat_not_member_id: /m,
    );
  });

  it.each([
    ["duplicate handle", DUPLICATE_HANDLE_TEAM],
    ["unknown repo grant", UNKNOWN_REPO_GRANT_TEAM],
    ["yaml syntax", YAML_SYNTAX_ERROR_TEAM],
    ["missing repos", MISSING_REPOS_TEAM],
  ])("exits 1 with file:line for %s", async (_name, team) => {
    const r = await ost(project(undefined, team), ["validate"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^error {4}\.outstaff\/team\.yaml:\d+:\d+ \S+: /);
    expect(r.out).toMatchSnapshot();
  });

  it("reports errors in JSON", async () => {
    const r = await ost(project(undefined, DUPLICATE_HANDLE_TEAM), ["validate", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: false,
      errors: [
        {
          code: "people.duplicate_handle",
          file: ".outstaff/team.yaml",
          line: expect.any(Number),
          column: expect.any(Number),
        },
      ],
    });
  });

  it("exits 1 when no team file exists", async () => {
    const r = await ost(project(), ["validate"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("config.not_found");
  });

  it("honors --team", async () => {
    const r = await ost(project(), ["--team", join(acme(), ".outstaff", "team.yaml"), "validate"]);
    expect(r.code).toBe(0);
  });
});

describe("ost workflow explain", () => {
  const event = JSON.stringify({
    type: "ticket.assigned",
    subject: { ticket: "ACME-1" },
    actor: { kind: "human", id: "dana" },
  });

  const state = JSON.stringify({
    tickets: { "ACME-1": { status: "ready", assignee: { id: "sam", kind: "agent" } } },
  });

  it("explains each rule against the event and state", async () => {
    const r = await ost(acme(), ["workflow", "explain", event, "--state", state]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("match    assigned-agent-scheduled");
    expect(r.out).toContain("schedule assigned for sam (normal)");
    expect(r.out).toContain("no match  pr-opened-review");
  });

  it("names the switch behind a rule and lists a rule a switch removed", async () => {
    const team = readFileSync(ACME_TEAM_FILE, "utf8").replace(
      "  conflicts:\n    follow_up: true\n",
      "  conflicts:\n    follow_up: false\n",
    );

    const conflicted = JSON.stringify({
      type: "pr.conflicted",
      subject: { pr: { repo: { owner: "acme", name: "app" }, number: 10 } },
      actor: { kind: "automation", id: "engine" },
    });

    const off = await ost(project(undefined, team), ["workflow", "explain", conflicted]);
    expect(off.out).toContain(
      "off       conflict-back-to-author: removed by policies.conflicts.follow_up",
    );

    const handed = JSON.stringify({
      type: "agent.handed_back",
      subject: { ticket: "ACME-1" },
      data: { status: "done" },
    });

    const on = await ost(acme(), ["workflow", "explain", handed]);
    expect(on.out).toContain("switch policies.hand_back.reassign");
    expect(on.out).not.toContain("removed by");
  });

  it("prints JSON", async () => {
    const r = await ost(acme(), ["workflow", "explain", event, "--state", state, "--json"]);
    expect(JSON.parse(r.out).effects).toEqual([
      expect.objectContaining({ type: "schedule", person: "sam", kind: "assigned" }),
    ]);
  });

  it("schedules PR feedback for the author when there is no linked ticket", async () => {
    const pr = { repo: { owner: "acme", name: "app" }, number: 10 };
    const r = await ost(acme(), [
      "workflow",
      "explain",
      JSON.stringify({
        type: "pr.comment",
        subject: { pr },
        actor: { kind: "human", id: "dana" },
        data: { body: "please add a test" },
      }),
      "--state",
      JSON.stringify({
        prs: [
          {
            ref: pr,
            title: "Add search",
            headRef: "sam/search",
            baseRef: "main",
            draft: false,
            state: "open",
            author: { login: "acme-sam[bot]", kind: "agent", person: "sam" },
          },
        ],
      }),
    ]);

    expect(r.out).toContain("match    human-feedback-back-to-author");
    expect(r.out).toContain("schedule review_feedback for sam (high)");
    expect(r.out).toContain("no match  human-feedback-reactivates-ticket");
  });

  it("works against an empty world", async () => {
    const r = await ost(acme(), ["workflow", "explain", '{"type":"pr.opened"}']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Effects\n  none");
  });

  it("rejects a malformed event or state", async () => {
    expect((await ost(acme(), ["workflow", "explain", "{"])).code).toBe(1);
    expect((await ost(acme(), ["workflow", "explain", '{"type":"nope"}'])).err).toContain('"type"');

    const bad = await ost(acme(), ["workflow", "explain", event, "--state", "[]"]);
    expect(bad.code).toBe(1);
  });
});

describe("ost policies", () => {
  it("lists every switch of the acme team with its value and source", async () => {
    const r = await ost(acme(), ["policies"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`SWITCH                             VALUE        SOURCE
policies.acknowledge.chat          true         team.yaml
policies.acknowledge.vcs           true         team.yaml
policies.chat.profile              true         team.yaml
policies.design.canvas             true         team.yaml
policies.feedback.follow_up_round  true         team.yaml
policies.feedback.merged_prs       true         team.yaml
policies.feedback.doc_comments     true         team.yaml
policies.feedback.ticket_comments  true         team.yaml
policies.hand_back.reassign        requester    team.yaml
policies.hand_back.fallback        first_human  team.yaml
policies.tickets.prs_per_ticket    one          team.yaml
policies.conflicts.follow_up       true         team.yaml
policies.retry.on_signal           true         team.yaml
`);
  });

  it("reports a switch the team set and one left at its default", async () => {
    const team = readFileSync(ACME_TEAM_FILE, "utf8")
      .replace("    vcs: true\n", "    vcs: false\n")
      .replace("  conflicts:\n    follow_up: true\n", "");

    const r = await ost(project(undefined, team), ["policies", "--json"]);
    const by = Object.fromEntries(JSON.parse(r.out).map((e: any) => [e.switch, e]));
    expect(by["policies.acknowledge.vcs"]).toMatchObject({ value: false, source: "team.yaml" });
    expect(by["policies.conflicts.follow_up"]).toMatchObject({ value: true, source: "default" });
  });
});

describe("ost team", () => {
  it("prints the resolved acme team", async () => {
    const r = await ost(acme(), ["team"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatchSnapshot();
  });

  it("notes the default trust rule when humans is omitted", async () => {
    const team = readFileSync(ACME_TEAM_FILE, "utf8").replace(
      /humans:[\s\S]*?\ncatalog:/,
      "catalog:",
    );

    const r = await ost(project(undefined, team), ["team"]);
    expect(r.out).toContain("Not listed; default rule");
  });

  it("prints JSON", async () => {
    const r = await ost(acme(), ["team", "--json"]);
    const json = JSON.parse(r.out);
    expect(Object.keys(json)).toEqual([
      "file",
      "team",
      "humans",
      "repos",
      "people",
      "integrations",
    ]);

    expect(json.people).toHaveLength(8);
  });

  it("exits 1 on an invalid config", async () => {
    const r = await ost(project(undefined, MISSING_REPOS_TEAM), ["team"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(".outstaff/team.yaml:");
  });
});

describe("ost init", () => {
  it("scaffolds a valid team in an empty directory", async () => {
    const dir = join(root, "Acme Shop!");
    mkdirSync(dir);
    const r = await ost(dir, ["init"]);
    expect(r).toMatchObject({ code: 0 });
    const text = readFileSync(join(dir, ".outstaff", "team.yaml"), "utf8");
    expect(text).toContain("name: acme-shop");
    expect(text).toContain("ost hire");
    expect(text).toContain("github.com/your-org/your-repo");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
      "# Outstaff secrets\n.outstaff/secrets/\n.outstaff/**/.env\n.env\n*.pem\n",
    );

    expect(r.out).toMatchSnapshot("init --separate-repo output");
    expect(text).toMatchSnapshot("init --separate-repo team.yaml");
    expect((await ost(dir, ["validate"])).code).toBe(0);
  });

  it("detects the repo from the git origin and only adds missing ignore rules", async () => {
    const dir = project("my-app");
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env");
    const r = await ost(dir, ["init"], "git@github.com:acme-example/shop-app.git");
    expect(r.code).toBe(0);
    const text = readFileSync(join(dir, ".outstaff", "team.yaml"), "utf8");
    expect(text).toContain(
      "name: shop-app\n    url: github.com/acme-example/shop-app\n    kind: primary",
    );

    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.env\n# Outstaff secrets\n.outstaff/secrets/\n.outstaff/**/.env\n*.pem\n",
    );

    expect((await ost(dir, ["validate"])).code).toBe(0);
  });

  it("accepts https origins", async () => {
    const dir = project();
    await ost(dir, ["init"], "https://github.com/acme-example/shop.git");
    expect(readFileSync(join(dir, ".outstaff", "team.yaml"), "utf8")).toContain(
      "url: github.com/acme-example/shop\n",
    );
  });

  it("refuses to overwrite without --force", async () => {
    const dir = acme();
    const before = readFileSync(join(dir, ".outstaff", "team.yaml"), "utf8");
    const r = await ost(dir, ["init"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe(".outstaff/team.yaml already exists. Use --force to overwrite it.\n");
    expect(readFileSync(join(dir, ".outstaff", "team.yaml"), "utf8")).toBe(before);
    expect((await ost(dir, ["init", "--force"])).code).toBe(0);
    expect(readFileSync(join(dir, ".outstaff", "team.yaml"), "utf8")).not.toBe(before);
  });

  it("--separate-repo writes team.yaml at the root", async () => {
    const dir = project("acme-team");
    const r = await ost(
      dir,
      ["init", "--separate-repo"],
      "git@github.com:acme-example/acme-team.git",
    );

    expect(r.code).toBe(0);
    const text = readFileSync(join(dir, "team.yaml"), "utf8");
    expect(text).toContain("`kind: primary`");
    expect(text).not.toContain("acme-team.git");
    expect(text).toMatchSnapshot();
    expect((await ost(dir, ["validate"])).code).toBe(0);
  });
});

describe("cli reference", () => {
  it("matches the committed page (run `pnpm --filter outstaff run docs:cli`)", () => {
    const committed = readFileSync(
      new URL("../../../docs/src/content/docs/reference/cli.md", import.meta.url),
      "utf8",
    );

    expect(committed).toBe(renderCliReference());
  });
});

describe("ost render", () => {
  const sam = ["render", "sam"];

  it("lists the files with sizes", async () => {
    const r = await ost(acme(), sam);
    expect(r.code).toBe(0);
    expect(r.out).toContain("skills/developer/SKILL.md");
    expect(r.out).toContain("references/style.md");
    expect(r.out).toMatch(/\d+ files \(pass --out/);
  });

  it("renders from the installed package root", async () => {
    const team = readFileSync(ACME_TEAM_FILE, "utf8");
    const r = await ost(project(undefined, team), sam, undefined, "");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("skills/developer/SKILL.md");
  });

  it("lets an ejected role replace the stock one", async () => {
    const cwd = acme();
    catalogDir(join(cwd.slice(root.length + 1), ".outstaff", "catalog"), {
      ...roleFiles("developer"),
      "roles/developer/SKILL.md": "Ejected developer.\n",
    });

    const r = await ost(cwd, [...sam, "--json"]);
    const files = (JSON.parse(r.out) as { files: { path: string; content: string }[] }).files;
    const content = files.find((f) => f.path.endsWith("developer/SKILL.md"))?.content;
    expect(content).toMatch(/^---\nname: developer\n/);
    expect(content).toMatch(/\n---\n\nEjected developer\.\n$/);
  });

  it("accepts an ejected dir with only some folders", async () => {
    const cwd = acme();
    catalogDir(join(cwd.slice(root.length + 1), ".outstaff", "catalog"), {
      "references/extra.md": "Extra.\n",
    });

    const r = await ost(cwd, [...sam, "--json"]);
    expect(r.code).toBe(0);
    const paths = (JSON.parse(r.out) as { files: { path: string }[] }).files.map((f) => f.path);
    expect(paths).toContain("references/extra.md");
    expect(paths).toContain("references/style.md");
  });

  it("writes to --out and refuses a non-empty directory without --force", async () => {
    const cwd = acme();
    const first = await ost(cwd, [...sam, "--out", "work"]);
    expect(first.code).toBe(0);
    expect(readFileSync(join(cwd, "work", "references", "style.md"), "utf8")).toBe(
      "Style at acme.\n",
    );

    const again = await ost(cwd, [...sam, "--out", "work"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("not empty");
    expect((await ost(cwd, [...sam, "--out", "work", "--force"])).code).toBe(0);
  });

  it("prints paths and contents with --json", async () => {
    const r = await ost(acme(), [...sam, "--json"]);
    const json = JSON.parse(r.out) as Record<string, unknown> & {
      files: { path: string; bytes: number; content: string }[];
    };

    expect(Object.keys(json).toSorted()).toEqual(
      ["extends", "files", "handle", "out", "role", "warnings"].toSorted(),
    );

    expect(json).toMatchObject({ handle: "sam", out: null });
    const f = json.files.find((x) => x.path === "references/style.md");
    expect(f).toEqual({
      path: "references/style.md",
      bytes: 15,
      content: "Style at acme.\n",
    });
  });

  it("fails for an unknown person", async () => {
    const r = await ost(acme(), ["render", "nobody"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Unknown person "nobody"');
  });
});

describe("roles from the merged catalog", () => {
  const withRole = (role: string) =>
    project(
      undefined,
      readFileSync(ACME_TEAM_FILE, "utf8").replace("role: reviewer", `role: ${role}`),
    );

  it("knows a client-only role from the ejected catalog", async () => {
    const cwd = withRole("auditor");
    catalogDir(join(cwd.slice(root.length + 1), ".outstaff", "catalog"), roleFiles("auditor"));
    expect((await ost(cwd, ["validate"])).code).toBe(0);
    expect((await ost(cwd, ["team"])).code).toBe(0);
  });

  it("rejects an unknown role in validate and team", async () => {
    const cwd = withRole("auditor");
    const v = await ost(cwd, ["validate"]);
    expect(v.code).toBe(1);
    expect(v.out).toContain('Role "auditor" is not in the catalog.');
    const t = await ost(cwd, ["team"]);
    expect(t.code).toBe(1);
    expect(t.err).toContain('Role "auditor" is not in the catalog.');
  });
});
