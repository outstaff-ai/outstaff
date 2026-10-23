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
import { loadCatalog } from "../catalog/load.js";
import { parseTeamConfig } from "../config/parse.js";
import type { TeamConfig } from "../config/schema.js";
import { readAcmeTeam } from "../testing/fixtures.js";
import { renderPerson, renderTeam, RenderError } from "./render.js";
import { renderToDir } from "./write.js";

const CATALOG_PKG = fileURLToPath(new URL("../../../catalog", import.meta.url));
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

/** The stock catalog only ships the example role, so every acme person plays it. */
const asExample: TeamConfig = {
  ...acme,
  people: acme.people.map((p) => ({ ...p, role: "example", extends: undefined })),
};

const stock = loadCatalog(CATALOG_PKG);

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
      const result = renderPerson({ team: asExample, handle: person.handle, catalog: stock });
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
    expect([...r.files.keys()]).toEqual([
      "process/example-lifecycle.md",
      "skills/example/SKILL.md",
    ]);

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
    expect(r.files.get("skills/example/SKILL.md")).toBe("ejected acme\n");
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
    expect([...r.files.values()].join("")).not.toContain("Sam Duarte");
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
