import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { ACME_TEAM_FILE } from "../../../core/src/testing/fixtures.js";
import type { Context } from "../types.js";
import { run } from "../program.js";
import type { AnyDef } from "../commands/types.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ost-setup-")));
let n = 0;

/** A git repository holding the acme team; `ignored` are the lines of its .gitignore. */
function project(ignored: string[] = [".outstaff/**/.env", ".outstaff/secrets/"]) {
  const dir = join(root, `p${n++}`);
  mkdirSync(join(dir, ".outstaff"), { recursive: true });
  writeFileSync(join(dir, ".outstaff", "team.yaml"), readFileSync(ACME_TEAM_FILE, "utf8"));
  writeFileSync(join(dir, ".gitignore"), `${ignored.join("\n")}\n`);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

async function ost(cwd: string, args: string[], extra: Partial<Context> = {}) {
  let out = "";
  let err = "";
  const ctx: Context = {
    cwd,
    env: {},
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    gitOrigin: () => undefined,
    ...extra,
  };

  const code = await run(args, ctx);
  return { code, out: out.replaceAll(root, "<tmp>"), err: err.replaceAll(root, "<tmp>") };
}

const example = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");

describe("ost setup template", () => {
  it("lists the keys a person needs, with a comment each", async () => {
    const dir = project();
    const r = await ost(dir, ["setup", "mira"]);
    expect(r.code).toBe(0);
    const text = example(dir, ".outstaff/people/mira/.env.example");
    expect(text).toMatchSnapshot();
    for (const key of [
      "OUTSTAFF_AGENT_TOKEN",
      "GH_APP_ID",
      "SLACK_BOT_TOKEN",
      "ITSAPLAN_API_KEY",
    ]) {
      expect(text).toContain(`\n${key}=\n`);
    }

    // Tracker and knowledge share one key.
    expect(text.match(/^ITSAPLAN_API_KEY=/gm)).toHaveLength(1);
    expect(text).not.toMatch(/=\S/);
  });

  it("lists no GitHub keys for a person without repository grants", async () => {
    const dir = project();
    expect((await ost(dir, ["setup", "leo"])).code).toBe(0);
    const text = example(dir, ".outstaff/people/leo/.env.example");
    expect(text).toMatchSnapshot();
    expect(text).toContain("\nSLACK_BOT_TOKEN=\n");
    expect(text).not.toContain("GH_");
  });

  it("lists the office App and an optional own App for a reader", async () => {
    const dir = project();
    expect((await ost(dir, ["setup", "ines"])).code).toBe(0);
    const text = example(dir, ".outstaff/people/ines/.env.example");
    expect(text).toContain("\nGH_OFFICE_APP_ID=\n");
    const blockOf = (key: string) => text.split("\n\n").find((b) => b.endsWith(`\n${key}=`))!;
    expect(blockOf("GH_APP_ID")).toContain("# Optional.");
    expect(blockOf("GH_OFFICE_APP_ID")).toContain("# Required.");
  });

  it("lists the office's keys, one agent token per person, the office Slack token and no runtime keys", async () => {
    const dir = project();
    expect((await ost(dir, ["setup", "office"])).code).toBe(0);
    const text = example(dir, ".outstaff/office/.env.example");
    expect(text).toMatchSnapshot();
    expect(text).toContain("OUTSTAFF_AGENT_TOKEN_MIRA=");
    expect(text).toContain("SLACK_OFFICE_BOT_TOKEN=");
    expect(text).not.toMatch(/^SLACK_(BOT|APP)_TOKEN=/m);
    expect(text).not.toContain("ANTHROPIC_API_KEY");
  });

  it("prints a guide for each configured adapter", async () => {
    const dir = project();
    const r = await ost(dir, ["setup", "mira", "--json"]);
    const { guides, unsupported } = JSON.parse(r.out) as {
      guides: { adapter: string; steps: { title: string; body: string; manifest?: string }[] }[];
      unsupported: string[];
    };

    expect(guides.map((g) => g.adapter)).toEqual([
      "slack (chat)",
      "github (vcs)",
      "claude-agent-sdk (runtime)",
      "itsaplan (tracker)",
    ]);

    expect(unsupported).toEqual(["avatars/dicebear"]);
    const by: Record<string, (typeof guides)[number]["steps"]> = Object.fromEntries(
      guides.map((g) => [g.adapter.split(" ")[0]!, g.steps]),
    );

    expect(by["slack"]!.some((s) => s.manifest?.includes("socket_mode_enabled: true"))).toBe(true);
    expect(by["github"]![0]!.manifest).toContain('"contents": "write"');
    expect(by["github"]![1]!.body).toContain("github.com/acme-example/shop`");
    expect(by["claude-agent-sdk"]![0]!.body).toContain("claude setup-token");
    expect(by["itsaplan"]!.map((s) => s.title)).toContain("A human accepts the invite");

    const text = (await ost(dir, ["setup", "mira"])).out;
    expect(text).toMatchSnapshot();
  });

  it("gives the office App read-only permissions on every repository", async () => {
    const r = await ost(project(), ["setup", "office", "--json"]);
    const { guides } = JSON.parse(r.out) as {
      guides: { adapter: string; steps: { body: string; manifest?: string }[] }[];
    };

    const github = guides.find((g) => g.adapter === "github (vcs)")!;
    expect(github.steps[0]!.manifest).not.toContain("write");
    expect(github.steps[1]!.body).toContain("github.com/acme-example/docs-site");
  });

  it("rejects an unknown person", async () => {
    const r = await ost(project(), ["setup", "nobody"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Unknown person "nobody"');
  });
});

describe("ost setup gitignore check", () => {
  it("refuses when the .env file and the secrets directory are not ignored, and shows the fix", async () => {
    const dir = project([]);
    const r = await ost(dir, ["setup", "mira"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("  .outstaff/**/.env");
    expect(r.err).toContain("  .outstaff/secrets/\n");
    expect(r.err).not.toContain("mira/");
    expect(existsSync(join(dir, ".outstaff/people/mira/.env.example"))).toBe(false);
  });

  it("refuses when only the secrets directory is missing from .gitignore", async () => {
    const r = await ost(project([".outstaff/**/.env"]), ["setup", "mira", "--secrets-dir", "keys"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("  keys/");
    expect(r.err).not.toContain(".outstaff/people");
  });

  it("does not mind a secrets directory outside the repository", async () => {
    const outside = join(root, "elsewhere");
    const r = await ost(project([".outstaff/**/.env"]), [
      "setup",
      "mira",
      "--secrets-dir",
      outside,
    ]);

    expect(r.code).toBe(0);
  });
});

describe("ost setup project layout", () => {
  it("finds the team file from a subdirectory and writes to the project root", async () => {
    const dir = project();
    const sub = join(dir, "packages", "app");
    mkdirSync(sub, { recursive: true });
    const r = await ost(sub, ["setup", "mira"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, ".outstaff/people/mira/.env.example"))).toBe(true);
    expect(existsSync(join(sub, ".outstaff"))).toBe(false);
    expect(r.out).toContain("Secret files go in <tmp>/");
    expect(r.out).toContain(`${join(dir, ".outstaff", "secrets", "mira").replace(root, "<tmp>")}/`);
    expect(example(dir, ".outstaff/people/mira/.env.example")).toContain(
      `#   ${join(dir, ".outstaff", "secrets", "mira")}/`,
    );
  });

  it("shows the default secrets directory relative to the current directory", async () => {
    const dir = project();
    const r = await ost(dir, ["setup", "mira"]);
    expect(r.out).toContain("Secret files go in .outstaff/secrets/mira/, one file per key.");
  });

  it("keeps --out as an override of the project root", async () => {
    const dir = project();
    const elsewhere = join(root, `o${n++}`);
    mkdirSync(elsewhere);
    const r = await ost(dir, ["setup", "mira", "--out", elsewhere]);
    expect(r.code).toBe(0);
    expect(existsSync(join(elsewhere, ".outstaff/people/mira/.env.example"))).toBe(true);
  });

  it("derives into the default directory and honours both overrides", async () => {
    const dir = project();
    const registry = fakes();
    const home = join(root, `home${n++}`);
    const base = ["setup", "mira", "--derive"];
    mkdirSync(join(dir, ".outstaff", "secrets", "mira"), { recursive: true });
    writeFileSync(join(dir, ".outstaff", "secrets", "mira", "GITHUB_TOKEN"), "tok\n");
    const a = await ost(dir, base, { registry, home });
    expect(a.code).toBe(0);
    expect(existsSync(join(dir, ".outstaff", "secrets", "mira", "GITHUB_ID"))).toBe(true);

    writeFileSync(join(dir, ".gitignore"), ".outstaff/**/.env\nkeys/\n");
    mkdirSync(join(dir, "keys"));
    writeFileSync(join(dir, "keys", "GITHUB_TOKEN"), "tok\n");
    const b = await ost(dir, [...base, "--secrets-dir", "keys"], { registry, home });
    expect(b.code).toBe(0);
    expect(existsSync(join(dir, "keys", "GITHUB_ID"))).toBe(true);
  });

  it("checks the actual directory, so an unrelated ignore of secrets/ does not count", async () => {
    const dir = project([".outstaff/**/.env", "/secrets/"]);
    const r = await ost(dir, ["setup", "mira"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("  .outstaff/secrets/\n");
  });

  it("asks for nothing when .outstaff/secrets/ is ignored by a parent rule", async () => {
    const dir = project([".outstaff/**/.env", ".outstaff/"]);
    expect((await ost(dir, ["setup", "mira"])).code).toBe(0);
  });
});

const SECRET_VALUE = "super-secret-derived-value";

/** Adapters whose hooks are fakes; each declares one derivable key. */
function fakes(): AdapterRegistry {
  const fake = (port: string, name: string, derive?: AnyDef["derive"]): AnyDef =>
    ({
      port,
      name,
      capabilities: [],
      secrets: () => [
        { key: `${name.toUpperCase()}_TOKEN`, description: "d", where: "w" },
        { key: `${name.toUpperCase()}_ID`, description: "d", where: "w", derivable: true },
      ],
      derive,
      create: () => ({}),
    }) as unknown as AnyDef;

  return new AdapterRegistry()
    .register(
      fake("vcs", "github", async (secrets, ctx) => {
        ctx.warn("not installed yet");
        return {
          GITHUB_ID: `${secrets.require("GITHUB_TOKEN")}-${SECRET_VALUE}`,
          GITHUB_TOKEN: "must not be overwritten or accepted",
        };
      }),
    )
    .register(
      fake("chat", "slack", async () => {
        throw new Error("auth.test failed");
      }),
    );
}

describe("ost setup --derive", () => {
  const withTokens = (dir: string, secrets: string) => {
    mkdirSync(join(dir, secrets), { recursive: true });
    writeFileSync(join(dir, secrets, "GITHUB_TOKEN"), "tok\n");
  };

  it("writes derived values as files and prints no value", async () => {
    const dir = project();
    withTokens(dir, join(".outstaff", "secrets", "mira"));
    const registry = fakes();
    const r = await ost(dir, ["setup", "mira", "--derive"], { registry });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Wrote GITHUB_ID");
    expect(r.out).toContain("warning  github: not installed yet");
    expect(r.out).toContain("warning  slack: auth.test failed");
    expect(r.out + r.err).not.toContain(SECRET_VALUE);
    expect(r.out + r.err).not.toContain("tok-");

    const file = join(dir, ".outstaff", "secrets", "mira", "GITHUB_ID");
    expect(readFileSync(file, "utf8")).toBe(`tok-${SECRET_VALUE}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, ".outstaff", "secrets", "mira", "GITHUB_TOKEN"), "utf8")).toBe(
      "tok\n",
    );

    expect(existsSync(join(dir, ".outstaff/people/mira/.env.example"))).toBe(false);
  });

  it("keeps values out of the JSON report and takes the directory from OUTSTAFF_SECRETS_DIR", async () => {
    const dir = project();
    withTokens(dir, "keys");
    const r = await ost(dir, ["setup", "mira", "--derive", "--json"], {
      registry: fakes(),
      env: { OUTSTAFF_SECRETS_DIR: join(dir, "keys") },
    });

    // "keys/" is inside the repository and not ignored.
    expect(r.code).toBe(1);

    writeFileSync(join(dir, ".gitignore"), ".outstaff/**/.env\nkeys/\n");
    const ok = await ost(dir, ["setup", "mira", "--derive", "--json"], {
      registry: fakes(),
      env: { OUTSTAFF_SECRETS_DIR: join(dir, "keys") },
    });

    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ written: ["GITHUB_ID"] });
    expect(ok.out).not.toContain(SECRET_VALUE);
    expect(existsSync(join(dir, "keys", "GITHUB_ID"))).toBe(true);
  });

  it("reads the environment when no file exists", async () => {
    const dir = project();
    const r = await ost(dir, ["setup", "mira", "--derive"], {
      registry: fakes(),
      env: { GITHUB_TOKEN: "from-env" },
    });

    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, ".outstaff", "secrets", "mira", "GITHUB_ID"), "utf8")).toContain(
      "from-env-",
    );
  });

  describe("downloaded private key", () => {
    const setupKey = () => {
      const dir = project();
      const home = join(root, `home${n++}`);
      mkdirSync(join(home, "Downloads"), { recursive: true });
      mkdirSync(join(dir, ".outstaff", "secrets", "mira"), { recursive: true });
      writeFileSync(join(dir, ".outstaff", "secrets", "mira", "GH_APP_SLUG"), "acme-mira\n");
      const pem = join(home, "Downloads", "acme-mira.2026-01-01.private-key.pem");
      writeFileSync(pem, "-----BEGIN KEY-----\nabc\n");
      writeFileSync(join(home, "Downloads", "other-app.2026-01-01.private-key.pem"), "x");
      return { dir, home, pem };
    };

    const registry = () => new AdapterRegistry();

    it("moves it into the secrets directory with --yes", async () => {
      const { dir, home, pem } = setupKey();
      const r = await ost(dir, ["setup", "mira", "--derive", "--yes"], {
        home,
        registry: registry().register(fakes().get("vcs", "github")!),
      });

      expect(r.code).toBe(0);
      expect(r.out).toContain("GH_APP_PRIVATE_KEY");
      expect(r.out).not.toContain("BEGIN KEY");
      expect(
        readFileSync(join(dir, ".outstaff", "secrets", "mira", "GH_APP_PRIVATE_KEY"), "utf8"),
      ).toContain("abc");

      expect(existsSync(pem)).toBe(false);
      expect(existsSync(join(home, "Downloads", "other-app.2026-01-01.private-key.pem"))).toBe(
        true,
      );
    });

    it("asks first and leaves it alone when declined or when there is nobody to ask", async () => {
      const { dir, home, pem } = setupKey();
      const asked: string[] = [];
      await ost(dir, ["setup", "mira", "--derive"], {
        home,
        confirm: async (q) => (asked.push(q), false),
      });

      expect(asked).toHaveLength(1);
      expect(existsSync(pem)).toBe(true);

      const r = await ost(dir, ["setup", "mira", "--derive"], { home });
      expect(r.out).toContain("--yes");
      expect(existsSync(pem)).toBe(true);
    });
  });
});

describe("ost setup network tokens", () => {
  it("lists the bearer token of a granted service among the person's secrets", async () => {
    const dir = project();
    const team = join(dir, ".outstaff", "team.yaml");
    writeFileSync(
      team,
      readFileSync(team, "utf8").replace(
        "  - handle: mira\n",
        '  - handle: mira\n    network:\n      http:\n        - { name: home, url: "https://home.acme.example", token: HOME_TOKEN }\n',
      ),
    );

    const r = await ost(dir, ["setup", "mira", "--json"]);
    expect(r.out).toContain("HOME_TOKEN");
    expect(r.out).not.toContain("HOME_TOKEN=secret");
    const other = await ost(dir, ["setup", "ines", "--json"]);
    expect(other.out).not.toContain("HOME_TOKEN");
  });
});
