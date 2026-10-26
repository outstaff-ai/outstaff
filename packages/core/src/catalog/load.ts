import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { toConfigIssues } from "../config/issues.js";
import { parseYaml } from "../config/locate.js";
import { CATALOG_CODES, CatalogError } from "./codes.js";
import { roleSchema } from "./role.js";
import { parseTemplate } from "./template-parse.js";
import type {
  Catalog,
  CatalogDoc,
  CatalogIssue,
  CatalogRole,
  LoadCatalogOptions,
} from "./types.js";

const subdirs = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory())
        .toSorted()
    : [];

/**
 * Loads a catalog directory: `roles/<role>/{role.yaml,SKILL.md}`,
 * `process/*.md`, `references/*.md`, `templates/*.md`. Every folder is optional,
 * so an ejected catalog may hold only some of them. `profiles/` is reserved
 * and ignored. Throws CatalogError listing every problem with file:line:column.
 */
export function loadCatalog(dir: string, options: LoadCatalogOptions = {}): Catalog {
  const issues: CatalogIssue[] = [];
  const add = (code: string, message: string, file: string, line = 1, column = 1) =>
    issues.push({ code, message, file, line, column });

  const read = (file: string): string | undefined => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      add(CATALOG_CODES.readFailed, "Cannot read file.", file);
      return undefined;
    }
  };

  const doc = (name: string, file: string): CatalogDoc | undefined => {
    const text = read(file);
    if (text === undefined) {
      return undefined;
    }

    try {
      parseTemplate(text, { file });
    } catch (e) {
      if (e instanceof CatalogError) {
        issues.push(...e.issues);
      } else {
        throw e;
      }
    }

    return { name, file, text };
  };

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    add(CATALOG_CODES.notFound, "Not a catalog: the directory does not exist.", dir);
    throw new CatalogError(issues);
  }

  let version = options.version;
  if (version === undefined) {
    const pkg = join(dir, "package.json");
    const text = existsSync(pkg) ? read(pkg) : undefined;
    try {
      const v =
        text === undefined ? undefined : (JSON.parse(text) as { version?: unknown }).version;

      if (typeof v === "string" && v) {
        version = v;
      }
    } catch {
      /* reported below */
    }

    if (version === undefined) {
      add(
        CATALOG_CODES.versionMissing,
        'No "version" in package.json; pass the version option.',
        pkg,
      );
    }
  }

  const roles: Record<string, CatalogRole> = {};
  const roleFile: Record<string, { file: string; locate: ReturnType<typeof parseYaml>["locate"] }> =
    {};

  for (const name of subdirs(join(dir, "roles"))) {
    const roleDir = join(dir, "roles", name);
    const yamlFile = join(roleDir, "role.yaml");
    if (!existsSync(yamlFile)) {
      add(CATALOG_CODES.missingFile, 'Role directory has no "role.yaml".', roleDir);
      continue;
    }

    const text = read(yamlFile);
    if (text === undefined) {
      continue;
    }

    const parsed = parseYaml(text);
    if (parsed.syntaxErrors.length) {
      for (const e of parsed.syntaxErrors) {
        add(CATALOG_CODES.yamlSyntax, e.message, yamlFile, e.position.line, e.position.column);
      }

      continue;
    }

    const result = roleSchema.safeParse(parsed.value);
    if (!result.success) {
      for (const issue of toConfigIssues(result.error)) {
        const at = parsed.locate(issue);
        add(
          `catalog.${issue.code.replace(/^schema\./, "")}`,
          `${issue.path.join(".") || "role"}: ${issue.message}`,
          yamlFile,
          at.line,
          at.column,
        );
      }

      continue;
    }

    const role = result.data;
    roleFile[name] = { file: yamlFile, locate: parsed.locate };
    if (role.name !== name) {
      const at = parsed.locate({ path: ["name"], code: "", message: "" });
      add(
        CATALOG_CODES.nameMismatch,
        `Role name "${role.name}" must equal its directory name "${name}".`,
        yamlFile,
        at.line,
        at.column,
      );
    }

    const file = join(roleDir, role.files.skill);
    if (existsSync(file)) {
      const skill = doc(`${name}/skill`, file);
      if (skill) {
        roles[name] = { ...role, dir: roleDir, skill };
      }
    } else {
      const at = parsed.locate({ path: ["files", "skill"], code: "", message: "" });
      add(
        CATALOG_CODES.missingFile,
        `Missing skill file "${role.files.skill}".`,
        yamlFile,
        at.line,
        at.column,
      );
    }
  }

  for (const [name, role] of Object.entries(roles)) {
    (role.extends ?? []).forEach((target, i) => {
      if (roleFile[target]) {
        return;
      }

      const at = roleFile[name]!.locate({ path: ["extends", i], code: "", message: "" });
      add(
        CATALOG_CODES.unknownExtends,
        `Role "${name}" extends unknown role "${target}".`,
        roleFile[name]!.file,
        at.line,
        at.column,
      );
    });
  }

  // Cycles, including self-extension.
  const state = new Map<string, 1 | 2>();
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === 2) {
      return;
    }

    if (state.get(name) === 1) {
      const loop = [...path.slice(path.indexOf(name)), name];
      const at = roleFile[name]!.locate({ path: ["extends"], code: "", message: "" });
      add(
        CATALOG_CODES.extendsCycle,
        `Roles extend each other in a loop: ${loop.join(" -> ")}.`,
        roleFile[name]!.file,
        at.line,
        at.column,
      );

      return;
    }

    state.set(name, 1);
    for (const t of roles[name]?.extends ?? []) {
      if (roles[t]) {
        visit(t, [...path, name]);
      }
    }

    state.set(name, 2);
  };

  for (const name of Object.keys(roles)) {
    visit(name, []);
  }

  const docsIn = (kind: "process" | "references" | "templates"): Record<string, CatalogDoc> => {
    const out: Record<string, CatalogDoc> = {};
    const base = join(dir, kind);
    if (!existsSync(base)) {
      return out;
    }

    for (const f of readdirSync(base)
      .filter((n) => n.endsWith(".md"))
      .toSorted()) {
      const d = doc(f.slice(0, -3), join(base, f));
      if (d) {
        out[d.name] = d;
      }
    }

    return out;
  };

  const processDocs = docsIn("process");
  const references = docsIn("references");
  const templates = docsIn("templates");

  if (issues.length || version === undefined) {
    throw new CatalogError(issues);
  }

  return { version, dir, roles, process: processDocs, references, templates };
}
