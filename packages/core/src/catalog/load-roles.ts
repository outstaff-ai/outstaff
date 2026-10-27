import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { toConfigIssues } from "#/config/issues.js";
import { parseYaml } from "#/config/locate.js";
import { CATALOG_CODES } from "./codes.js";
import type { Loading } from "./loading.js";
import { roleSchema } from "./role.js";
import type { CatalogDoc, CatalogRole } from "./types.js";

type Locate = ReturnType<typeof parseYaml>["locate"];
type Role = Omit<CatalogRole, "dir" | "skill">;

/** Where a role was read from: its name, its folder, its role.yaml and positions in that file. */
type RoleSource = { name: string; dir: string; file: string; locate: Locate };

/** The roles that loaded, and the source of every role whose role.yaml was valid. */
type LoadedRoles = { roles: Record<string, CatalogRole>; sources: Record<string, RoleSource> };

const subdirs = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory())
        .toSorted()
    : [];

/** Loads `roles/<role>/{role.yaml,SKILL.md}`, then checks what the roles extend. */
export function loadRoles(l: Loading, dir: string): Record<string, CatalogRole> {
  const loaded: LoadedRoles = { roles: {}, sources: {} };
  for (const name of subdirs(join(dir, "roles"))) {
    loadRole(l, name, join(dir, "roles", name), loaded);
  }

  checkExtends(l, loaded);
  checkCycles(l, loaded);

  return loaded.roles;
}

function loadRole(l: Loading, name: string, dir: string, loaded: LoadedRoles): void {
  const file = join(dir, "role.yaml");
  const read = readRole(l, dir, file);
  if (!read) {
    return;
  }

  const { role, locate } = read;
  const source: RoleSource = { name, dir, file, locate };
  loaded.sources[name] = source;
  if (role.name !== name) {
    l.add(
      CATALOG_CODES.nameMismatch,
      `Role name "${role.name}" must equal its directory name "${name}".`,
      file,
      locate({ path: ["name"], code: "", message: "" }),
    );
  }

  const skill = loadSkill(l, role, source);
  if (skill) {
    loaded.roles[name] = { ...role, dir, skill };
  }
}

/** A role.yaml, valid against the role schema; undefined, with the problems recorded, otherwise. */
function readRole(
  l: Loading,
  dir: string,
  file: string,
): { role: Role; locate: Locate } | undefined {
  if (!existsSync(file)) {
    l.add(CATALOG_CODES.missingFile, 'Role directory has no "role.yaml".', dir);
    return undefined;
  }

  const text = l.read(file);
  if (text === undefined) {
    return undefined;
  }

  const parsed = parseYaml(text);
  for (const e of parsed.syntaxErrors) {
    l.add(CATALOG_CODES.yamlSyntax, e.message, file, e.position);
  }

  if (parsed.syntaxErrors.length) {
    return undefined;
  }

  const result = roleSchema.safeParse(parsed.value);
  if (result.success) {
    return { role: result.data, locate: parsed.locate };
  }

  for (const issue of toConfigIssues(result.error)) {
    l.add(
      `catalog.${issue.code.replace(/^schema\./, "")}`,
      `${issue.path.join(".") || "role"}: ${issue.message}`,
      file,
      parsed.locate(issue),
    );
  }
}

function loadSkill(l: Loading, role: Role, source: RoleSource): CatalogDoc | undefined {
  const file = join(source.dir, role.files.skill);
  if (existsSync(file)) {
    return l.doc(`${source.name}/skill`, file);
  }

  l.add(
    CATALOG_CODES.missingFile,
    `Missing skill file "${role.files.skill}".`,
    source.file,
    source.locate({ path: ["files", "skill"], code: "", message: "" }),
  );
}

function checkExtends(l: Loading, { roles, sources }: LoadedRoles): void {
  for (const [name, role] of Object.entries(roles)) {
    (role.extends ?? []).forEach((target, i) => {
      if (sources[target]) {
        return;
      }

      const source = sources[name]!;
      l.add(
        CATALOG_CODES.unknownExtends,
        `Role "${name}" extends unknown role "${target}".`,
        source.file,
        source.locate({ path: ["extends", i], code: "", message: "" }),
      );
    });
  }
}

/** Roles that extend each other in a loop, including a role that extends itself. */
function checkCycles(l: Loading, { roles, sources }: LoadedRoles): void {
  // 1 while a role's ancestors are being visited, 2 once they all have been.
  const state = new Map<string, 1 | 2>();
  const visit = (name: string, path: string[]): void => {
    const seen = state.get(name);
    if (seen === 1) {
      const loop = [...path.slice(path.indexOf(name)), name];
      const source = sources[name]!;
      l.add(
        CATALOG_CODES.extendsCycle,
        `Roles extend each other in a loop: ${loop.join(" -> ")}.`,
        source.file,
        source.locate({ path: ["extends"], code: "", message: "" }),
      );
    }

    if (seen !== undefined) {
      return;
    }

    state.set(name, 1);
    for (const t of (roles[name]?.extends ?? []).filter((r) => roles[r])) {
      visit(t, [...path, name]);
    }

    state.set(name, 2);
  };

  for (const name of Object.keys(roles)) {
    visit(name, []);
  }
}
