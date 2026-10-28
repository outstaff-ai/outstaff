import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { loadCatalog } from "#/catalog/load.js";
import { parseTeamConfig } from "#/config/parse.js";
import type { TeamConfig } from "#/config/types.js";
import { EXAMPLE_CATALOG_DIR, readAcmeTeam } from "@outstaff/testing.core";
import { renderPerson, renderTeam, RenderError } from "#/render/render.js";
import { renderToDir } from "#/render/write.js";

const CATALOG_PKG = fileURLToPath(new URL("../../../../catalog", import.meta.url));
const GOLDEN = fileURLToPath(new URL("./__golden__", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "outstaff-render-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const acme: TeamConfig = (() => {
  const r = parseTeamConfig(parse(readAcmeTeam()));
  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
})();

/** The fixture catalog only has the example role, so every acme person plays it. */
const asExample: TeamConfig = {
  ...acme,
  people: acme.people.map((p) => ({ ...p, role: "example", extends: undefined })),
};

const real = loadCatalog(CATALOG_PKG);
const stock = loadCatalog(EXAMPLE_CATALOG_DIR);

let n = 0;
const make = (files: Record<string, string>): string => {
  const dir = join(root, `c${n++}`);
  for (const [rel, text] of Object.entries({ "package.json": '{"version":"1.0.0"}', ...files })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }

  return dir;
};

const role = (name: string, extra = "") =>
  `name: ${name}\ntitle: ${name}\nsummary: s\ntoolset: base\npermissions: docs\n${extra}`;

const roleFiles = (name: string, extra = "", skill = `skill ${name}`) => ({
  [`roles/${name}/role.yaml`]: role(name, extra),
  [`roles/${name}/SKILL.md`]: skill,
});

const dump = (files: Map<string, string>): string =>
  [...files].map(([p, t]) => `=== ${p} ===\n${t}`).join("\n");

describe("golden output per acme person", () => {
  for (const person of acme.people) {
    it(`${person.handle}`, () => {
      const result = renderPerson({
        team: acme,
        handle: person.handle,
        catalog: real,
        workdir: "/work/dir",
      });

      const file = join(GOLDEN, `${person.handle}.txt`);
      const actual = dump(result.files);
      if (process.env.UPDATE_GOLDEN === "1") {
        mkdirSync(GOLDEN, { recursive: true });
        writeFileSync(file, actual);
      }

      expect(existsSync(file), `missing golden ${file}; run with UPDATE_GOLDEN=1`).toBe(true);
      expect(actual).toBe(readFileSync(file, "utf8"));
    });
  }

  it("hard-codes no commit count or message format; the defaults are worded as defaults", () => {
    for (const person of acme.people) {
      const text = dump(renderPerson({ team: acme, handle: person.handle, catalog: real }).files);
      expect(text).not.toMatch(/one commit|type\(scope\)|fixup|amended onto|squash/i);
      expect(text).not.toMatch(
        /(use|with|from) `templates\/pull-request\.md` (for|\.)|never merge the base|resolve conflicts by rebasing/i,
      );
    }

    const git = renderPerson({ team: acme, handle: "sam", catalog: real }).files.get(
      "references/git.md",
    );

    expect(git).toContain("If the repository says nothing on a point, use these defaults");
  });

  it("renders the conventions a team states for a repo into the git reference", () => {
    const team = {
      ...acme,
      repos: acme.repos.map((r, i) =>
        i === 0 ? { ...r, conventions: "Squash merge. Titles start with the ticket key." } : r,
      ),
    };

    const git = renderPerson({ team, handle: "sam", catalog: real }).files.get("references/git.md");
    expect(git).toContain("Squash merge. Titles start with the ticket key.");
  });

  it("tells developer and devops to keep the pull request description current after a rebase", () => {
    for (const handle of ["sam", "kofi"]) {
      const files = renderPerson({ team: acme, handle, catalog: real }).files;
      expect(files.get("references/git.md")).toContain(
        "the description must still describe what the branch does now",
      );

      const skill = [...files].find(
        ([path]) => path.endsWith("SKILL.md") && /### rebase/.test(files.get(path) ?? ""),
      );

      expect(skill?.[1], `${handle} has a rebase section`).toContain(
        "Keep the pull request description current",
      );
    }
  });

  it("tells agents to settle the target repository only when the team has more than one", () => {
    const work = (team: TeamConfig) =>
      renderPerson({ team, handle: "sam", catalog: real }).files.get("process/work-items.md");

    expect(acme.repos.length).toBeGreaterThan(1);
    expect(work(acme)).toContain("## Which repository");
    expect(work({ ...acme, repos: acme.repos.slice(0, 1) })).not.toContain("## Which repository");
  });

  it("has no dangling process, reference or template path in any rendered file", () => {
    const roles = Object.keys(real.roles);
    expect(roles.length).toBeGreaterThan(1);
    const teams = [
      acme,
      ...roles.map((r) => ({
        ...acme,
        people: acme.people.map((p) => ({ ...p, role: r, extends: undefined })),
      })),
    ];

    const docPaths = (text: string) =>
      [...text.matchAll(/\/?[\w./-]*\b(?:process|references|templates)\/[\w.-]+\.md\b/g)].map(
        ([path]) => path,
      );

    const dangling: string[] = [];
    for (const team of teams) {
      const handle = team.people[0]!.handle;
      const { files } = renderPerson({ team, handle, catalog: real, workdir: "/work/dir" });
      for (const [file, text] of files) {
        const missing = docPaths(text).filter(
          (path) => !path.startsWith("/work/dir/") || !files.has(path.slice("/work/dir/".length)),
        );

        dangling.push(...missing.map((path) => `${file} -> ${path}`));
      }
    }

    expect([...new Set(dangling)]).toEqual([]);
  });

  it("tells every designer to view a canvas before publishing and to answer document threads", () => {
    const team = {
      ...acme,
      people: acme.people.map((p) => ({ ...p, role: "designer", extends: undefined })),
    };

    const files = renderPerson({ team, handle: team.people[0]!.handle, catalog: real }).files;
    expect(files.get("skills/designer/SKILL.md")).toContain("View before you publish");
    expect(files.get("skills/designer/SKILL.md")).toContain("Unknown skill");
    expect(files.get("process/doc-feedback.md")).toContain("Leave no addressed thread unanswered");
    expect(files.get("references/ost.md")).toContain("A denial covers exactly the command");
  });

  it("has no stale golden files", () => {
    expect(readdirSync(GOLDEN).toSorted()).toEqual(
      acme.people.map((p) => `${p.handle}.txt`).toSorted(),
    );
  });
});

describe("renderPerson", () => {
  it("returns role, profile, layout and normalized text", () => {
    const r = renderPerson({ team: asExample, handle: "sam", catalog: stock });
    expect(r.role).toBe("example");
    expect(r.extends).toEqual([]);
    expect(r.profile).toBe("readonly");
    expect([...r.files.keys()]).toContain("process/example-lifecycle.md");
    expect([...r.files.keys()]).toContain("skills/example/SKILL.md");

    for (const text of r.files.values()) {
      expect(text).not.toContain("\r");
      expect(text.endsWith("\n")).toBe(true);
      expect(text.endsWith("\n\n")).toBe(false);
    }
  });

  it("is deterministic", () => {
    const a = renderPerson({ team: asExample, handle: "mira", catalog: stock });
    const b = renderPerson({ team: asExample, handle: "mira", catalog: stock });
    expect([...a.files]).toEqual([...b.files]);
    expect(a).toEqual(b);
  });

  it("warns about needs the team cannot meet", () => {
    const team = {
      ...asExample,
      integrations: { ...asExample.integrations, tracker: undefined },
    } as TeamConfig;

    const r = renderPerson({ team, handle: "sam", catalog: stock });
    expect(r.warnings.map((w) => w.message)).toEqual([
      'Role "example" needs tracker.issues but the team has no tracker integration.',
    ]);
  });

  it("rejects an unknown person", () => {
    expect(() => renderPerson({ team: asExample, handle: "nobody", catalog: stock })).toThrow(
      /Unknown person "nobody"/,
    );
  });

  it("lets ejected files win over stock files with the same path", () => {
    const ejected = loadCatalog(
      make({
        ...roleFiles("example", "", "ejected {{ team.name }}"),
        "references/guide.md": "ref {{ team.name }}",
      }),
    );

    const r = renderPerson({ team: asExample, handle: "sam", catalog: stock, ejected });
    expect(r.files.get("skills/example/SKILL.md")).toBe(
      "---\nname: example\ndescription: s\n---\n\nejected acme\n",
    );

    expect(r.files.get("references/guide.md")).toBe("ref acme\n");
    expect(r.files.get("process/example-lifecycle.md")).toContain("acme");
  });

  describe("extends", () => {
    const catalog = loadCatalog(
      make({
        ...roleFiles("lead", "extends: [qa]\n"),
        ...roleFiles("dev"),
        ...roleFiles("qa", "extends: [docs]\n"),
        ...roleFiles("docs"),
        ...roleFiles("ops"),
      }),
    );

    const team = (extra?: string[]): TeamConfig => ({
      ...acme,
      people: acme.people.map((p) =>
        p.handle === "sam" ? { ...p, role: "lead", extends: extra } : p,
      ),
    });

    it("orders role first, then person extends, then role extends, deduped and transitive", () => {
      const r = renderPerson({ team: team(["dev", "qa", "ops"]), handle: "sam", catalog });
      expect(r.extends).toEqual(["dev", "qa", "ops", "docs"]);
      expect([...r.files.keys()].filter((k) => k.startsWith("skills/"))).toEqual([
        "skills/dev/SKILL.md",
        "skills/docs/SKILL.md",
        "skills/lead/SKILL.md",
        "skills/ops/SKILL.md",
        "skills/qa/SKILL.md",
      ]);
    });

    it("works without person-level extends", () => {
      expect(renderPerson({ team: team(), handle: "sam", catalog }).extends).toEqual([
        "qa",
        "docs",
      ]);
    });

    it("reports an unknown extended role", () => {
      expect(() => renderPerson({ team: team(["ghost"]), handle: "sam", catalog })).toThrow(
        /extends unknown role "ghost"/,
      );
    });
  });

  it("collects every error with positions into one RenderError", () => {
    const catalog = loadCatalog(
      make({
        ...roleFiles("example", "", "ok\n{{ nope.one }}\n"),
        "references/a.md": "line1\n  {{ team.nme }}",
        "templates/b.md": "{{ team.name }} {{ missing }}",
      }),
    );

    let error: unknown;
    try {
      renderPerson({ team: asExample, handle: "sam", catalog });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(RenderError);
    const issues = (error as RenderError).issues.map(
      (i) => `${i.file.split("/").slice(-2).join("/")}:${i.line}:${i.column} ${i.message}`,
    );

    expect(issues).toEqual([
      'example/SKILL.md:2:1 Unknown placeholder "nope.one".',
      'references/a.md:2:3 Unknown placeholder "team.nme".',
      'templates/b.md:1:17 Unknown placeholder "missing".',
    ]);
  });
});

/** Splits a rendered skill into its parsed front matter and body. */
const split = (text: string): { meta: Record<string, unknown>; body: string } => {
  const m = /^---\n([\s\S]*?)---\n\n([\s\S]*)$/.exec(text);
  if (!m) {
    throw new Error(`No front matter in:\n${text}`);
  }

  return { meta: parse(m[1]!) as Record<string, unknown>, body: m[2]! };
};

describe("skill front matter", () => {
  const skillOf = (skill: string, extra = "", summary = "s") => {
    const dir = make({
      "roles/example/role.yaml": role("example", extra).replace(
        "summary: s",
        `summary: ${summary}`,
      ),
      "roles/example/SKILL.md": skill,
    });

    const r = renderPerson({ team: asExample, handle: "sam", catalog: loadCatalog(dir) });
    return r.files.get("skills/example/SKILL.md")!;
  };

  it("starts every stock skill with its role name and summary", () => {
    const team: TeamConfig = {
      ...acme,
      people: acme.people.map((p) => ({ ...p, extends: undefined })),
    };

    for (const person of team.people) {
      const r = renderPerson({ team, handle: person.handle, catalog: real });
      const text = r.files.get(`skills/${person.role}/SKILL.md`)!;
      expect(text.startsWith("---\n")).toBe(true);
      const { meta, body } = split(text);
      expect(meta).toEqual({
        name: person.role,
        description: real.roles[person.role]!.summary,
      });

      expect(body.startsWith("---")).toBe(false);
    }
  });

  it("quotes YAML-special summaries so they round-trip", () => {
    const summary = "'Fix: bugs # and \"things\" - [fast]'";
    const { meta } = split(skillOf("body\n", "", summary));
    expect(meta.description).toBe('Fix: bugs # and "things" - [fast]');
  });

  it("keeps a source description and falls back to the summary without one", () => {
    const own = split(skillOf("---\ndescription: mine\n---\nbody\n"));
    expect(own.meta).toEqual({ name: "example", description: "mine" });
    const none = split(skillOf("---\nallowed-tools: Bash\n---\nbody\n"));
    expect(none.meta.description).toBe("s");
  });

  it("merges source front matter instead of duplicating it", () => {
    const text = skillOf(
      "---\nname: other\ndescription: mine\nallowed-tools: Bash\n---\n# Title\n",
    );

    const { meta, body } = split(text);
    expect(meta).toEqual({ name: "example", description: "mine", "allowed-tools": "Bash" });
    expect(body).toBe("# Title\n");
    expect(text.match(/^---$/gm)).toHaveLength(2);
  });

  it("fails on invalid source front matter with a located error", () => {
    expect(() => skillOf("---\nname: [oops\n---\nbody\n")).toThrow(/catalog\.front_matter_invalid/);
  });

  it("does not treat a leading horizontal rule without a closing marker as front matter", () => {
    const { body } = split(skillOf("---\nnot front matter\n"));
    expect(body).toBe("---\nnot front matter\n");
  });
});

describe("role-level skills", () => {
  it("fails a person placeholder in a skill with a located error", () => {
    const catalog = loadCatalog(
      make({
        ...roleFiles("example", "", "ok\nHi {{ person.name }}\n"),
        "references/r.md": "{{ person.handle }}",
      }),
    );

    let error: unknown;
    try {
      renderPerson({ team: asExample, handle: "sam", catalog });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(RenderError);
    expect(
      (error as RenderError).issues.map(
        (i) => `${i.file.split("/").slice(-2).join("/")}:${i.line}:${i.column} ${i.code}`,
      ),
    ).toEqual([
      "example/SKILL.md:2:4 catalog.unknown_placeholder",
      "references/r.md:1:1 catalog.unknown_placeholder",
    ]);
  });

  it("has no identity in the output", () => {
    const r = renderPerson({ team: asExample, handle: "sam", catalog: stock });
    const skills = [...r.files].filter(([k]) => k.startsWith("skills/")).map(([, t]) => t);
    expect(skills.join("")).not.toContain("Sam Duarte");
  });

  it("gives people with the same role identical files", () => {
    const team = renderTeam({ team: asExample, catalog: stock });
    const sam = team.get("sam")!;
    const noor = team.get("noor")!;
    const shared = [...sam.files.keys()];
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.map((path) => noor.files.get(path))).toEqual(
      shared.map((path) => sam.files.get(path)),
    );

    expect(team.size).toBe(acme.people.length);
    expect(team.get("sam")).toEqual(
      renderPerson({ team: asExample, handle: "sam", catalog: stock }),
    );
  });

  it("reports a role-level error once for the whole team", () => {
    const catalog = loadCatalog(make(roleFiles("example", "", "{{ person.name }}")));
    expect(() => renderTeam({ team: asExample, catalog })).toThrow(RenderError);

    let error: unknown;
    try {
      renderTeam({ team: asExample, catalog });
    } catch (e) {
      error = e;
    }

    expect((error as RenderError).issues).toHaveLength(1);
  });
});

describe("renderToDir", () => {
  it("writes files and refuses a non-empty directory without force", () => {
    const out = join(root, "out");
    const r = renderToDir({ team: asExample, handle: "sam", catalog: stock, out });
    expect(readFileSync(join(out, "skills/example/SKILL.md"), "utf8")).toBe(
      r.files.get("skills/example/SKILL.md"),
    );

    expect(() => renderToDir({ team: asExample, handle: "sam", catalog: stock, out })).toThrow(
      /not empty/,
    );

    expect(() =>
      renderToDir({ team: asExample, handle: "sam", catalog: stock, out, force: true }),
    ).not.toThrow();
  });
});

describe("designer skill: Design canvas", () => {
  const skill = (team: TeamConfig) =>
    renderPerson({ team, handle: "leo", catalog: real }).files.get("skills/designer/SKILL.md")!;

  it("has the canvas guidance, and the no-code rule", () => {
    const text = skill(acme);
    expect(text).toContain("#### The Design canvas");
    expect(text).toContain("`ArtifactComments`");
    expect(text).toContain("link");
    expect(text).toContain("Attach the exports");
    expect(text).toContain("You do not read code.");
    expect(text).toContain("Do not ask for the code.");
  });

  it("drops the canvas guidance when the team switches the canvas off", () => {
    const off = { ...acme, policies: { ...acme.policies!, design: { canvas: false } } };
    expect(skill(off)).not.toContain("Design canvas");
  });
});
