import { CATALOG_CODES, CatalogError } from "./codes.js";
import { parseTemplate } from "./template-parse.js";
import type {
  CatalogIssue,
  RenderOptions,
  TemplateNode as Node,
  TemplatePos as Pos,
} from "./types.js";

type Scope = { item: unknown; index: number };
type Found = { found: true; value: unknown } | { found: false };

/** One rendering: the context, and the problems found so far. */
type Rendering = { context: unknown; file: string; issues: CatalogIssue[] };

function resolve(path: string, root: unknown, scopes: Scope[]): Found {
  const [first, ...more] = path.split(".");
  if (first !== "@index" && first !== "this") {
    return walk(root, path.split("."));
  }

  const scope = scopes.at(-1);
  if (!scope) {
    return { found: false };
  }

  return first === "@index" ? { found: true, value: scope.index } : walk(scope.item, more);
}

/** The value at the end of `keys` from `value`, each an own key of the object before it. */
function walk(value: unknown, keys: string[]): Found {
  let cur = value;
  for (const key of keys) {
    if (typeof cur !== "object" || cur === null || !Object.hasOwn(cur, key)) {
      return { found: false };
    }

    cur = (cur as Record<string, unknown>)[key];
  }

  return { found: true, value: cur };
}

const truthy = (v: unknown): boolean =>
  !(
    v === undefined ||
    v === null ||
    v === false ||
    v === "" ||
    v === 0 ||
    (Array.isArray(v) && v.length === 0)
  );

/** Renders a template against a context. Throws CatalogError listing every problem. */
export function render(template: string, context: unknown, options: RenderOptions = {}): string {
  const parsed = parseTemplate(template, options);
  const r: Rendering = { context, file: parsed.file, issues: [] };
  const out = renderNodes(r, parsed.nodes, []);
  if (r.issues.length) {
    throw new CatalogError(r.issues);
  }

  return out;
}

function renderNodes(r: Rendering, nodes: Node[], scopes: Scope[]): string {
  return nodes.map((node) => renderNode(r, node, scopes)).join("");
}

function renderNode(r: Rendering, node: Node, scopes: Scope[]): string {
  switch (node.t) {
    case "text":
      return node.text;
    case "var":
      return renderVar(r, node, scopes);
    case "each":
      return renderEach(r, node, scopes);
    default: {
      const shown = truthy(lookup(r, node.path, node.pos, scopes)) === (node.t === "if");
      return renderNodes(r, shown ? node.body : node.otherwise, scopes);
    }
  }
}

function renderVar(r: Rendering, node: Extract<Node, { t: "var" }>, scopes: Scope[]): string {
  const v = lookup(r, node.path, node.pos, scopes);
  if (v === undefined || v === null) {
    return "";
  }

  if (typeof v === "object") {
    problem(
      r,
      CATALOG_CODES.notScalar,
      `"${node.path}" is a ${Array.isArray(v) ? "list" : "group"}; use a field or {{#each}}.`,
      node.pos,
    );

    return "";
  }

  return String(v);
}

function renderEach(r: Rendering, node: Extract<Node, { t: "each" }>, scopes: Scope[]): string {
  const v = lookup(r, node.path, node.pos, scopes);
  if (v === undefined || v === null) {
    return "";
  }

  if (!Array.isArray(v)) {
    problem(r, CATALOG_CODES.notIterable, `"${node.path}" is not a list.`, node.pos);
    return "";
  }

  return v.map((item, index) => renderNodes(r, node.body, [...scopes, { item, index }])).join("");
}

function problem(r: Rendering, code: string, message: string, pos: Pos): void {
  r.issues.push({ code, message, file: r.file, ...pos });
}

/** The value at a path; undefined, with a problem recorded, when there is none. */
function lookup(r: Rendering, path: string, pos: Pos, scopes: Scope[]): unknown {
  const found = resolve(path, r.context, scopes);
  if (!found.found) {
    problem(r, CATALOG_CODES.unknownPlaceholder, `Unknown placeholder "${path}".`, pos);
    return undefined;
  }

  return found.value;
}
