import {
  isCollection,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Node,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import { CONFIG_CODES } from "./codes.js";
import type { ConfigIssue, ParsedYaml, Position } from "./types.js";

/** These issues are about a key itself, so they point at the key rather than its value. */
const KEY_CODES: string[] = [
  CONFIG_CODES.unknownKey,
  CONFIG_CODES.peopleUnknownRepo,
  CONFIG_CODES.peopleInvalidGrantKey,
];

export function parseYaml(text: string): ParsedYaml {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const at = (offset: number): Position => {
    const { line, col } = lineCounter.linePos(offset);
    return { line, column: col };
  };

  const start = (node: Node | null | undefined): Position | undefined =>
    node?.range ? at(node.range[0]) : undefined;

  const syntaxErrors = doc.errors.map((e) => ({
    message: e.message.split("\n")[0] ?? e.message,
    position: e.linePos?.[0] ? { line: e.linePos[0].line, column: e.linePos[0].col } : at(e.pos[0]),
  }));

  const locate = (issue: ConfigIssue): Position => locateIn(doc.contents, issue, start);

  return { value: doc.errors.length ? undefined : doc.toJS(), syntaxErrors, locate };
}

type Start = (node: Node | null | undefined) => Position | undefined;

/** A node reached along an issue's path, the position to report for it, and its key's when it is a map entry. */
type Step = { node: unknown; best: Position; keyPos: Position | undefined };

/** The position of the deepest node the issue's path reaches; its key, when the issue is about a key. */
function locateIn(root: unknown, issue: ConfigIssue, start: Start): Position {
  let at: Step = {
    node: root,
    best: start(root as Node | null) ?? { line: 1, column: 1 },
    keyPos: undefined,
  };

  for (const seg of issue.path) {
    const next = stepInto(at, seg, start);
    if (!next) {
      return at.best;
    }

    at = next;
  }

  const aboutKey = typeof issue.path.at(-1) === "string" && KEY_CODES.includes(issue.code);

  return at.keyPos && aboutKey ? at.keyPos : at.best;
}

function stepInto(at: Step, seg: string | number, start: Start): Step | undefined {
  if (isMap(at.node)) {
    return mapEntry(at.node, seg, at.best, start);
  }

  if (isSeq(at.node) && typeof seg === "number") {
    return seqItem(at.node, seg, at.best, start);
  }

  return undefined;
}

/** A collection or an empty value is reported at its key; a scalar at itself. */
function mapEntry(
  map: YAMLMap,
  seg: string | number,
  best: Position,
  start: Start,
): Step | undefined {
  const pair = map.items.find((p) => isScalar(p.key) && String(p.key.value) === String(seg));
  if (!pair) {
    return undefined;
  }

  const keyPos = start(pair.key as Node) ?? best;
  const next = pair.value as Node | null;

  return {
    node: next,
    keyPos,
    best: (isCollection(next) || !next ? keyPos : start(next)) ?? keyPos,
  };
}

function seqItem(seq: YAMLSeq, index: number, best: Position, start: Start): Step | undefined {
  const next = seq.items[index] as Node | undefined;

  return next ? { node: next, keyPos: undefined, best: start(next) ?? best } : undefined;
}
