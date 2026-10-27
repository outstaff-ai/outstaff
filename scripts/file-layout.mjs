#!/usr/bin/env node
// Source files stay small and keep types apart from implementations. Fails on a source file over
// MAX_LINES lines, and on a non-index file that exports both a type (or interface) and a runtime
// value. Shared types go in a folder's `types.ts`, a larger contract in `<name>.types.ts`. Also fails
// on a relative import that leaves its workspace package: another package is imported by name. Inside a
// package's `src`, an import that climbs out of its folder (`../`) uses the package's `#/` alias instead. And an
// integration (`integrations/<port>/<vendor>`) depends only on core, protocol and `integrations/shared/*`:
// never on another adapter, so two adapters of one vendor share code through a shared package. Workspace
// packages do not depend on each other in a cycle, except a package and the private test kit (`testing/*`)
// its tests use, which depends back on it; `ignoreWorkspaceCycles` in pnpm-workspace.yaml relies on this.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_LINES = 300;

// TypeScript source anywhere in the repository. Tests and type declarations are not checked; the
// repository has no generated TypeScript (generated JSON schema and docs are not source).
const SOURCE = /\.(ts|tsx|mts)$/;
const SKIPPED = [/(^|\/)__tests__\//, /\.d\.ts$/, /(^|\/)node_modules\//];

/** Paths (a trailing slash covers a folder) the check skips, each with the reason. */
export const EXEMPT = new Map([
  ["packages/office/src/engine/", "deleted by the event-pipeline redesign"],
  ["packages/core/src/workflow/presets.ts", "deleted by the event-pipeline redesign"],
  ["packages/core/src/workflow/resolve.ts", "deleted by the event-pipeline redesign"],
  ["packages/core/src/policies/switches.ts", "deleted by the event-pipeline redesign"],
  ["packages/office/src/chat/desk.ts", "chat desk routing, deleted by the event-pipeline redesign"],
  ["e2e/", "end-to-end test harness (driver, stubs, scripted runtime), not shipped"],
]);

/** Whether the file is product source the check covers. */
export function isSource(file) {
  return SOURCE.test(file) && !SKIPPED.some((pattern) => pattern.test(file));
}

/** The exemption reason for a file, if any. */
export function exemption(file) {
  for (const [prefix, reason] of EXEMPT) {
    if (prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix) {
      return reason;
    }
  }

  return undefined;
}

/** Whether the file is an entry point that may re-export both types and values. */
export function isIndex(file) {
  return /(^|\/)index\.(ts|tsx|mts)$/.test(file);
}

/** The kind ("type" or "value") of each name in an `export { ... }` list starting at `index`. */
function listKinds(source, index) {
  const list = source.slice(index).match(/^export\s+(type\s+)?\{([^}]*)\}/);
  const names = (list?.[2] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  return names.map((name) => (list?.[1] || name.startsWith("type ") ? "type" : "value"));
}

/** The kinds ("type" or "value") one top-level export statement exports. */
function statementKinds(source, match) {
  const [, modifier = "", head] = match;
  const typeOnly = modifier.startsWith("type");

  if (head.startsWith("{")) {
    return listKinds(source, match.index);
  }

  if (head.startsWith("*")) {
    return [typeOnly ? "type" : "value"];
  }

  return typeOnly || /^(interface|type)$/.test(head) ? ["type"] : ["value"];
}

/** Classifies a module's exports: whether it exports types and whether it exports runtime values. */
export function exportKinds(source) {
  // Top-level export statements start a line; the formatter guarantees it.
  const kinds = [...source.matchAll(/^export\s+(type\s+|declare\s+)?(\S+)/gm)].flatMap((match) =>
    statementKinds(source, match),
  );

  return { types: kinds.includes("type"), values: kinds.includes("value") };
}

/** Returns the problems in the given files, read with `read`. */
export function layoutProblems(files, read) {
  const problems = [];

  for (const file of files.filter(isSource)) {
    const source = read(file);
    const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);

    if (exemption(file)) {
      continue;
    }

    if (lines > MAX_LINES) {
      problems.push(`${file}: ${lines} lines, over ${MAX_LINES}; split it along its seams`);
    }

    if (!isIndex(file)) {
      const { types, values } = exportKinds(source);

      if (types && values) {
        problems.push(
          `${file}: exports types and runtime values; move the types to types.ts or <name>.types.ts`,
        );
      }
    }
  }

  return problems;
}

const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

// `from "x"`, `import "x"`, `import("x")`, `vi.mock("x")` and `require("x")`.
const SPECIFIER =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\(\s*|\brequire\(\s*)["']([^"']+)["']/g;

/** The relative module specifiers in a source file. */
export function relativeSpecifiers(source) {
  return [...source.matchAll(SPECIFIER)].map((m) => m[1]).filter((spec) => spec.startsWith("."));
}

/** The workspace package a path belongs to: the nearest folder in `roots` above it ("." is the root). */
export function packageOf(path, roots) {
  let dir = dirname(path);
  while (dir !== "." && !roots.has(dir)) {
    dir = dirname(dir);
  }

  return dir;
}

/** Returns the relative imports that resolve into another package, given the package folders. */
export function crossPackageImports(files, read) {
  const roots = new Set(
    files.filter((f) => f.endsWith("package.json") && !/(^|\/)node_modules\//.test(f)).map(dirname),
  );

  const problems = [];

  for (const file of files.filter((f) => CODE.test(f) && !/(^|\/)(node_modules|dist)\//.test(f))) {
    const own = packageOf(file, roots);
    for (const spec of relativeSpecifiers(read(file))) {
      const target = normalize(join(dirname(file), spec));
      if (target.startsWith("..") || packageOf(join(target, "x"), roots) !== own) {
        problems.push(`${file}: ${spec} leaves the package; import it by package name`);
      }
    }
  }

  return problems;
}

// The package's `src` folder a path is in: the shortest leading path that ends in a `src` folder.
const SRC = /^((?:[^/]+\/)*?src)\//;

/** Returns the relative imports inside a `src` folder that climb out of their own folder (`../`): `#/` replaces them. */
export function climbingImports(files, read) {
  const problems = [];

  for (const file of files.filter((f) => CODE.test(f) && !/(^|\/)(node_modules|dist)\//.test(f))) {
    const src = file.match(SRC)?.[1];
    for (const spec of src ? relativeSpecifiers(read(file)) : []) {
      if (spec.startsWith("../")) {
        const target = normalize(join(dirname(file), spec));
        const alias = target.startsWith(`${src}/`) ? `#/${target.slice(src.length + 1)}` : "#/…";
        problems.push(`${file}: ${spec} climbs out of its folder; import it as ${alias}`);
      }
    }
  }

  return problems;
}

const INTEGRATION = /^integrations\/[^/]+\/[^/]+$/;
const ALLOWED = /^@outstaff\/(core|protocol|integration\.shared\.[^/]+)(\/|$)/;
const TEST_KIT = /^@outstaff\/testing\.[^/]+(\/|$)/;
const TEST_FILE = /(^|\/)__tests__\//;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** Whether an integration may name this workspace package: test kits only from tests and devDependencies. */
const mayUse = (name, own, test) =>
  name === own ||
  ALLOWED.test(name) ||
  (test && TEST_KIT.test(name)) ||
  !name.startsWith("@outstaff/");

/** Returns where an integration depends on another adapter (or anything but core, protocol and shared packages). */
export function integrationDependencies(files, read) {
  const problems = [];
  for (const dir of files.filter((f) => f.endsWith("/package.json")).map(dirname)) {
    if (!INTEGRATION.test(dir)) {
      continue;
    }

    const pkg = JSON.parse(read(`${dir}/package.json`));
    problems.push(...dependenciesOf(dir, pkg), ...importsOf(files, read, dir, pkg.name));
  }

  return problems;
}

function dependenciesOf(dir, pkg) {
  return DEPENDENCY_FIELDS.flatMap((field) =>
    Object.keys(pkg[field] ?? {})
      .filter((name) => !mayUse(name, pkg.name, field === "devDependencies"))
      .map(
        (name) =>
          `${dir}/package.json: ${field} names ${name}; an integration depends only on core, protocol and integrations/shared/*`,
      ),
  );
}

function importsOf(files, read, dir, own) {
  const problems = [];
  for (const file of files.filter((f) => f.startsWith(`${dir}/`) && CODE.test(f))) {
    if (/(^|\/)(node_modules|dist)\//.test(file)) {
      continue;
    }

    const test = TEST_FILE.test(file.slice(dir.length + 1));
    for (const spec of [...read(file).matchAll(SPECIFIER)].map((m) => m[1])) {
      if (!mayUse(spec, own, test)) {
        problems.push(
          `${file}: imports ${spec}; an integration depends only on core, protocol and integrations/shared/*`,
        );
      }
    }
  }

  return problems;
}

const KIT_DIR = /^testing\/[^/]+$/;

/** The workspace packages by name: whether each is a private test kit, and the workspace packages it depends on. */
function workspaceGraph(files, read) {
  const manifests = files
    .filter((f) => f.endsWith("package.json") && !/(^|\/)node_modules\//.test(f))
    .map((f) => ({ dir: dirname(f), pkg: JSON.parse(read(f)) }))
    .filter(({ pkg }) => pkg.name);

  const names = new Set(manifests.map(({ pkg }) => pkg.name));
  const depsOf = (pkg) =>
    DEPENDENCY_FIELDS.flatMap((field) =>
      Object.keys(pkg[field] ?? {}).map((name) => ({ name, field })),
    ).filter(({ name }) => names.has(name));

  return new Map(
    manifests.map(({ dir, pkg }) => [
      pkg.name,
      { kit: KIT_DIR.test(dir) && pkg.private === true, deps: depsOf(pkg) },
    ]),
  );
}

/** Whether a dependency is a package's devDependency on a private test kit that depends back on the package. */
const isKitEdge = (graph, from, { name, field }) =>
  field === "devDependencies" &&
  graph.get(name).kit &&
  graph.get(name).deps.some((dep) => dep.name === from);

/** Returns the workspace dependency cycles, except a package and the private test kit (testing/*) its tests use. */
export function workspaceCycles(files, read) {
  const graph = workspaceGraph(files, read);
  const edges = new Map(
    [...graph].map(([name, node]) => [
      name,
      node.deps.filter((dep) => !isKitEdge(graph, name, dep)).map((dep) => dep.name),
    ]),
  );

  const cycles = new Set();
  const done = new Set();
  const visit = (name, path) => {
    if (path.includes(name)) {
      cycles.add([...path.slice(path.indexOf(name)), name].join(" -> "));
    } else if (!done.has(name)) {
      edges.get(name).forEach((next) => visit(next, [...path, name]));
      done.add(name);
    }
  };

  [...edges.keys()].forEach((name) => visit(name, []));

  return [...cycles].map(
    (cycle) =>
      `workspace dependency cycle: ${cycle}; only a package and the private test kit (testing/*) its tests use may depend on each other`,
  );
}

function main() {
  // Untracked files count too, so a split is checked before it is staged.
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => file && existsSync(file));

  const read = (file) => readFileSync(file, "utf8");
  const problems = [
    ...layoutProblems(files, read),
    ...crossPackageImports(files, read),
    ...workspaceCycles(files, read),
    ...climbingImports(files, read),
    ...integrationDependencies(files, read),
  ];

  for (const problem of problems) {
    console.error(problem);
  }

  if (problems.length) {
    console.error(`${problems.length} file layout problem${problems.length === 1 ? "" : "s"}.`);

    return 1;
  }

  console.log("File layout check passed.");

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
