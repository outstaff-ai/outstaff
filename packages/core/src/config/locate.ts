import { isCollection, isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from "yaml";
import { CONFIG_CODES } from "./codes.js";
import type { ConfigIssue } from "./issues.js";

export type Position = { line: number; column: number };
export type LocatedIssue = ConfigIssue & { file: string; line: number; column: number };

/** These issues are about a key itself, so they point at the key rather than its value. */
const KEY_CODES: string[] = [CONFIG_CODES.unknownKey, CONFIG_CODES.peopleUnknownRepo, CONFIG_CODES.peopleInvalidGrantKey];

export type ParsedYaml = {
  value: unknown;
  syntaxErrors: { message: string; position: Position }[];
  locate: (issue: ConfigIssue) => Position;
};

export function parseYaml(text: string): ParsedYaml {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const at = (offset: number): Position => {
    const { line, col } = lineCounter.linePos(offset);
    return { line, column: col };
  };
  const start = (node: Node | null | undefined): Position | undefined => (node?.range ? at(node.range[0]) : undefined);

  const syntaxErrors = doc.errors.map((e) => ({
    message: e.message.split("\n")[0] ?? e.message,
    position: e.linePos?.[0] ? { line: e.linePos[0].line, column: e.linePos[0].col } : at(e.pos[0]),
  }));

  const locate = (issue: ConfigIssue): Position => {
    let node: unknown = doc.contents;
    let best: Position = start(doc.contents as Node | null) ?? { line: 1, column: 1 };
    let keyPos: Position | undefined;
    for (const seg of issue.path) {
      if (isMap(node)) {
        const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(seg));
        if (!pair) return best;
        keyPos = start(pair.key as Node) ?? best;
        const next = pair.value as Node | null;
        best = (isCollection(next) || !next ? keyPos : start(next)) ?? keyPos;
        node = next;
      } else if (isSeq(node) && typeof seg === "number") {
        const next = node.items[seg] as Node | undefined;
        if (!next) return best;
        keyPos = undefined;
        best = start(next) ?? best;
        node = next;
      } else {
        return best;
      }
    }
    if (keyPos && typeof issue.path.at(-1) === "string" && KEY_CODES.includes(issue.code)) return keyPos;
    return best;
  };

  return { value: doc.errors.length ? undefined : doc.toJS(), syntaxErrors, locate };
}

