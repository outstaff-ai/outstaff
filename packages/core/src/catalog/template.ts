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

function resolve(path: string, root: unknown, scopes: Scope[]): Found {
  const segments = path.split(".");
  const scope = scopes.at(-1);
  let cur: unknown = root;
  let rest = segments;
  if (segments[0] === "@index" || segments[0] === "this") {
    if (!scope) {
      return { found: false };
    }

    if (segments[0] === "@index") {
      return { found: true, value: scope.index };
    }

    cur = scope.item;
    rest = segments.slice(1);
  }

  for (const key of rest) {
    if (typeof cur === "object" && cur !== null && Object.hasOwn(cur, key)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return { found: false };
    }
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
  const issues: CatalogIssue[] = [];
  const problem = (code: string, message: string, pos: Pos) =>
    issues.push({ code, message, file: parsed.file, ...pos });

  const lookup = (path: string, pos: Pos, scopes: Scope[]): unknown => {
    const r = resolve(path, context, scopes);
    if (!r.found) {
      problem(CATALOG_CODES.unknownPlaceholder, `Unknown placeholder "${path}".`, pos);
      return undefined;
    }

    return r.value;
  };

  const run = (nodes: Node[], scopes: Scope[]): string => {
    let out = "";
    for (const node of nodes) {
      if (node.t === "text") {
        out += node.text;
      } else if (node.t === "var") {
        const v = lookup(node.path, node.pos, scopes);
        if (v === undefined || v === null) {
          continue;
        }

        if (typeof v === "object") {
          problem(
            CATALOG_CODES.notScalar,
            `"${node.path}" is a ${Array.isArray(v) ? "list" : "group"}; use a field or {{#each}}.`,
            node.pos,
          );
        } else {
          out += String(v);
        }
      } else if (node.t === "if" || node.t === "unless") {
        const v = truthy(lookup(node.path, node.pos, scopes));
        out += run(v === (node.t === "if") ? node.body : node.otherwise, scopes);
      } else {
        const v = lookup(node.path, node.pos, scopes);
        if (v === undefined || v === null) {
          continue;
        }

        if (!Array.isArray(v)) {
          problem(CATALOG_CODES.notIterable, `"${node.path}" is not a list.`, node.pos);
          continue;
        }

        v.forEach((item, index) => {
          out += run(node.body, [...scopes, { item, index }]);
        });
      }
    }

    return out;
  };

  const out = run(parsed.nodes, []);
  if (issues.length) {
    throw new CatalogError(issues);
  }

  return out;
}
