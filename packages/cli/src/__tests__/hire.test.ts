import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACME_TEAM_FILE, copyAcmePolicies } from "@outstaff/testing.core";
import type { Context } from "#/types.js";
import { run } from "#/program.js";
import { addPerson, removePerson } from "#/teamfile.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ost-hire-")));
let n = 0;

const original = readFileSync(ACME_TEAM_FILE, "utf8");

/** A git repository holding the acme team. */
function project(team = original, ignored = [".env", "secrets/"]) {
  const dir = join(root, `p${n++}`);
  mkdirSync(join(dir, ".outstaff"), { recursive: true });
  writeFileSync(join(dir, ".outstaff", "team.yaml"), team);
  copyAcmePolicies(join(dir, ".outstaff"));
  writeFileSync(join(dir, ".gitignore"), `${ignored.join("\n")}\n`);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const teamOf = (dir: string) => readFileSync(join(dir, ".outstaff", "team.yaml"), "utf8");

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
  return { code, out, err };
}

const ALL_FLAGS = [
  "hire",
  "reviewer",
  "--name",
  "Wren Dalton",
  "--handle",
  "wren",
  "--pronouns",
  "she/her",
  "--model",
  "opus",
  "--avatar",
  "wren-seed",
  "--repos",
  "shop=write,*=read",
  "--yes",
];

describe("ost hire", () => {
  it("with every flag and --yes writes a valid team, the avatar and the setup template", async () => {
    const dir = project();
    const hired = await ost(dir, ALL_FLAGS);
    expect(hired.code).toBe(0);

    const yaml = teamOf(dir);
    expect(yaml).toContain("  - handle: wren\n    name: Wren Dalton\n    pronouns: she/her\n");
    expect(yaml).toContain("    model: opus\n");
    expect(yaml).toContain("avatar:\n      seed: wren-seed\n");

    const svg = readFileSync(join(dir, ".outstaff/people/wren/avatar.svg"), "utf8");
    expect(svg).toContain("<svg");
    expect(existsSync(join(dir, ".outstaff/people/wren/.env.example"))).toBe(true);

    expect(hired.out).toContain("Added Wren Dalton (wren)");
    expect(hired.out).toContain("OUTSTAFF_PERSON: wren");
    expect(hired.out).toContain("wren_OUTSTAFF_AGENT_TOKEN");
    expect(hired.out).toContain("OUTSTAFF_AGENT_TOKEN_WREN");
    expect(hired.out).toContain("nameSuffix: -wren");
    expect(hired.out).toContain("ost doctor wren");
    expect(hired.out).toMatch(/0 errors/);

    const checked = await ost(dir, ["validate", "--json"]);
    expect(checked.code).toBe(0);
    expect(JSON.parse(checked.out).ok).toBe(true);
  });

  it("generates what is missing and gives code roles write on the primary repository", async () => {
    const dir = project();
    const r = await ost(dir, ["hire", "developer", "--model", "sonnet", "--yes", "--json"]);
    expect(r.code).toBe(0);
    const { person, written, validate } = JSON.parse(r.out);
    expect(written).toBe(true);
    expect(person.pronouns).toBe("they/them");
    expect(person.handle).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(person.avatar).toEqual({ seed: person.handle });
    expect(person.repos).toEqual({ shop: "write", "*": "read" });
    expect(person.model).toBe("sonnet");
    expect(validate.ok).toBe(true);
  });

  it("gives infra roles write on the infra repository and read roles read only", async () => {
    const dir = project();
    const infra = JSON.parse(
      (await ost(dir, ["hire", "devops", "--model", "sonnet", "--yes", "--json"])).out,
    );

    expect(infra.person.repos).toEqual({ infra: "write", "*": "read" });
    const reviewer = JSON.parse(
      (await ost(dir, ["hire", "reviewer", "--model", "sonnet", "--yes", "--json"])).out,
    );

    expect(reviewer.person.repos).toEqual({ "*": "read" });
  });

  it("makes a colliding handle unique and refuses a colliding explicit one", async () => {
    const dir = project();
    const first = JSON.parse(
      (
        await ost(dir, [
          "hire",
          "developer",
          "--model",
          "sonnet",
          "--name",
          "Sam Duarte",
          "--yes",
          "--json",
        ])
      ).out,
    );

    expect(first.person.handle).toBe("sam-2");
    const second = JSON.parse(
      (
        await ost(dir, [
          "hire",
          "developer",
          "--model",
          "sonnet",
          "--name",
          "Sam Other",
          "--yes",
          "--json",
        ])
      ).out,
    );

    expect(second.person.handle).toBe("sam-3");

    const before = teamOf(dir);
    const clash = await ost(dir, [
      "hire",
      "developer",
      "--model",
      "sonnet",
      "--handle",
      "sam",
      "--yes",
    ]);

    expect(clash.code).toBe(1);
    expect(clash.err).toContain('"sam" is already used');
    expect(teamOf(dir)).toBe(before);
  });

  it("never uses the office scope name, and rejects invalid handles", async () => {
    const dir = project();
    const office = JSON.parse(
      (
        await ost(dir, [
          "hire",
          "pm",
          "--model",
          "sonnet",
          "--name",
          "Office Worker",
          "--yes",
          "--json",
        ])
      ).out,
    );

    expect(office.person.handle).toBe("office-2");
    const bad = await ost(dir, [
      "hire",
      "pm",
      "--model",
      "sonnet",
      "--handle",
      "Not_Valid",
      "--yes",
    ]);

    expect(bad.code).toBe(1);
    expect(bad.err).toContain("not a valid handle");
  });

  it("refuses an unknown role and bad grants without touching the file", async () => {
    const dir = project();
    const role = await ost(dir, ["hire", "wizard", "--model", "sonnet", "--yes"]);
    expect(role.code).toBe(1);
    expect(role.err).toContain('No role "wizard"');
    expect(role.err).toContain("developer");

    const grants = await ost(dir, [
      "hire",
      "developer",
      "--model",
      "sonnet",
      "--repos",
      "nope=write",
      "--yes",
    ]);

    expect(grants.code).toBe(1);
    expect(grants.err).toContain("not a repo of this team");
    expect(teamOf(dir)).toBe(original);
  });

  it("accepts a custom role", async () => {
    const dir = project();
    expect((await ost(dir, ["role", "new", "auditor"])).code).toBe(0);
    const r = await ost(dir, ["hire", "auditor", "--model", "sonnet", "--yes", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).person.role).toBe("auditor");
  });

  it("keeps comments, quoting and everything else as it was", async () => {
    const commented = original
      .replace("people:\n", "people:\n  # the first two are the planners\n")
      .replace("role: pm", "role: pm # keeps the plan")
      .replace("handle: sam", 'handle: "sam"');

    const dir = project(commented);
    expect((await ost(dir, [...ALL_FLAGS])).code).toBe(0);
    const yaml = teamOf(dir);
    expect(yaml).toContain("# Synthetic example");
    expect(yaml).toContain("  # the first two are the planners\n");
    expect(yaml).toContain("role: pm # keeps the plan");
    expect(yaml).toContain('handle: "sam"');
    expect(yaml).toContain("extends: [developer]");

    // Only the new person was added.
    const added = yaml.slice(yaml.indexOf("  - handle: wren"), yaml.indexOf("\nintegrations:"));

    expect(yaml.replace(added, "")).toBe(commented);
  });

  it("writes a person into an empty people list", async () => {
    const dir = project(original.replace(/^people:[\s\S]*?\n(?=integrations:)/m, "people: []\n\n"));
    const r = await ost(dir, [
      "hire",
      "developer",
      "--model",
      "sonnet",
      "--yes",
      "--name",
      "Ari Lindqvist",
    ]);

    expect(r.code).toBe(0);
    expect(teamOf(dir)).toContain("people:\n  - handle: ari\n");
  });

  it("stores an avatar URL and renders nothing", async () => {
    const dir = project();
    const r = await ost(dir, [
      "hire",
      "pm",
      "--model",
      "sonnet",
      "--handle",
      "pat",
      "--avatar",
      "https://images.acme.example/pat.png",
      "--yes",
    ]);

    expect(r.code).toBe(0);
    expect(teamOf(dir)).toContain("url: https://images.acme.example/pat.png");
    expect(existsSync(join(dir, ".outstaff/people/pat/avatar.svg"))).toBe(false);
  });

  it("skips the avatar when the team has no avatars adapter", async () => {
    const dir = project(original.replace(/ {2}avatars:\n.*\n.*\n/, ""));
    const r = await ost(dir, ["hire", "pm", "--model", "sonnet", "--handle", "pat", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No integrations.avatars");
  });

  it("needs --yes without a terminal and writes nothing", async () => {
    const dir = project();
    const r = await ost(dir, ["hire", "developer", "--model", "sonnet"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--yes");
    expect(teamOf(dir)).toBe(original);

    const json = await ost(dir, ["hire", "developer", "--model", "sonnet", "--json"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out).written).toBe(false);
  });

  it("asks for each generated value and confirms in a terminal", async () => {
    const dir = project();
    const asked: string[] = [];
    const answers: Record<string, string> = {
      Pronouns: "he/him",
      Handle: "dev-one",
      Model: "opus",
    };

    const r = await ost(dir, ["hire", "developer"], {
      ask: async (q, fallback) => {
        asked.push(q);
        return answers[q] ?? fallback;
      },
      confirm: async () => true,
    });

    expect(r.code).toBe(0);
    expect(asked).toEqual([
      "Name",
      "Handle",
      "Pronouns",
      "Model",
      "Repo access (repo=read|write, comma separated)",
    ]);

    expect(teamOf(dir)).toContain("model: opus");
    expect(teamOf(dir)).toContain("handle: dev-one");
    expect(teamOf(dir)).toContain("pronouns: he/him");
    expect(r.out).toContain("Repos:     shop=write,*=read");
  });

  it("needs a model, given or answered, and writes nothing without one", async () => {
    const dir = project();
    const flagless = await ost(dir, ["hire", "developer", "--yes"]);
    expect(flagless.code).toBe(1);
    expect(flagless.err).toBe(
      "error    Give the model the person runs on with --model, for example --model sonnet. There is no default model.\n",
    );

    const unanswered = await ost(dir, ["hire", "developer"], {
      ask: async (q, fallback) => (q === "Model" ? "  " : fallback),
      confirm: async () => true,
    });

    expect(unanswered.code).toBe(1);
    expect(unanswered.err).toContain("--model");
    expect(teamOf(dir)).toBe(original);
  });

  it("writes nothing when the confirmation is declined", async () => {
    const dir = project();
    const r = await ost(dir, ["hire", "developer", "--model", "sonnet"], {
      ask: async (_q, fallback) => fallback,
      confirm: async () => false,
    });

    expect(r.code).toBe(1);
    expect(teamOf(dir)).toBe(original);
  });

  it("refuses before writing when git would not ignore the secrets", async () => {
    const dir = project(original, []);
    const r = await ost(dir, ALL_FLAGS);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Nothing was written");
    expect(teamOf(dir)).toBe(original);
  });
});

const withGroups = original.replace(
  "policies:\n",
  "policies:\n  usage:\n    shared:\n      - [sam, noor]\n      - [mira, leo, ines]\n",
);

describe("ost fire", () => {
  it("removes the person, keeps the rest and prints the checklist", async () => {
    const dir = project(withGroups);
    const r = await ost(dir, ["fire", "kofi", "--yes"]);
    expect(r.code).toBe(0);
    const yaml = teamOf(dir);
    expect(yaml).not.toContain("handle: kofi");
    expect(yaml).toContain("# Synthetic example");
    expect(yaml).toContain("handle: ines");
    expect(r.out).toContain("acme-kofi[bot]");
    expect(r.out).toContain("Clean up by hand");
    expect(r.out).toContain("people/kofi/");
    expect(r.out).toMatch(/0 errors/);
  });

  it("removes the person from usage groups, shrinking or dropping them", async () => {
    const dir = project(withGroups);
    const r = await ost(dir, ["fire", "ines", "--yes"]);
    expect(r.code).toBe(0);
    expect(teamOf(dir)).toContain("- [mira, leo]");
    expect(r.out).toContain("[mira, leo, ines] becomes [mira, leo]");

    const dropped = await ost(dir, ["fire", "sam", "--yes", "--json"]);
    expect(dropped.code).toBe(0);
    const report = JSON.parse(dropped.out);
    expect(report.usage).toEqual([{ before: ["sam", "noor"], after: null }]);
    expect(teamOf(dir)).not.toContain("[sam, noor]");
    expect(report.validate.ok).toBe(true);
    expect(report.checklist.length).toBeGreaterThan(3);
  });

  it("removes an emptied shared list", async () => {
    const dir = project(
      original.replace("policies:\n", "policies:\n  usage:\n    shared:\n      - [sam, noor]\n"),
    );

    expect((await ost(dir, ["fire", "noor", "--yes"])).code).toBe(0);
    expect(teamOf(dir)).not.toContain("shared");
  });

  it("refuses an unknown handle", async () => {
    const dir = project();
    const r = await ost(dir, ["fire", "nobody", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Unknown person "nobody"');
    expect(r.err).toContain("sam");
    expect(teamOf(dir)).toBe(original);
  });

  it("asks to confirm, and needs --yes without a terminal", async () => {
    const dir = project();
    const no = await ost(dir, ["fire", "sam"], { confirm: async () => false });
    expect(no.code).toBe(1);
    expect(teamOf(dir)).toBe(original);

    const none = await ost(dir, ["fire", "sam"]);
    expect(none.code).toBe(1);
    expect(none.err).toContain("--yes");

    const yes = await ost(dir, ["fire", "sam"], { confirm: async () => true });
    expect(yes.code).toBe(0);
    expect(teamOf(dir)).not.toContain("handle: sam");
  });

  it("undoes a hire", async () => {
    const dir = project();
    expect((await ost(dir, ALL_FLAGS)).code).toBe(0);
    expect((await ost(dir, ["fire", "wren", "--yes"])).code).toBe(0);
    expect(teamOf(dir)).toBe(original);
  });
});

describe("team file edits", () => {
  it("lists other mentions of a handle without changing them", () => {
    const yaml = original.replace("policies:\n", "policies:\n  commands:\n    note: [sam]\n");

    const removal = removePerson(yaml, "sam");
    expect(removal?.references).toEqual(["policies.commands.note.0"]);
  });

  it("round-trips a flow-style people list", () => {
    const out = addPerson("people: []\n", {
      handle: "a",
      name: "A B",
      pronouns: "they/them",
      role: "pm",
      model: "sonnet",
      repos: { "*": "read" },
    });

    expect(out).toBe(
      'people:\n  - handle: a\n    name: A B\n    pronouns: they/them\n    role: pm\n    model: sonnet\n    repos:\n      "*": read\n',
    );
  });
});
