import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MESSAGE_META,
  PROTOCOL_VERSION,
  decode,
  encode,
  messageSchema,
  renderProtocolReference,
} from "./index.js";

const types = messageSchema.options.map((o) => o.shape.type.value);

describe("protocol", () => {
  it("is versioned", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
  });

  it("documents every message type exactly once", () => {
    expect(Object.keys(MESSAGE_META).toSorted()).toEqual(types.toSorted());
    expect(new Set(types).size).toBe(types.length);
  });

  it("only names replies that exist", () => {
    for (const meta of Object.values(MESSAGE_META)) {
      for (const r of meta.replies) {
        expect(types).toContain(r);
      }
    }
  });

  it("round-trips a message", () => {
    const m = { id: "1", type: "accept", payload: { workItemId: "w1" } } as const;
    expect(decode(encode(m))).toEqual({ ok: true, message: m });
  });

  it.each([
    ["not json", "{", "malformed", undefined],
    ["an array", "[]", "malformed", undefined],
    ["no type", '{"id":"a"}', "malformed", "a"],
    ["an unknown type", '{"id":"a","type":"nope","payload":{}}', "unknown_type", "a"],
    ["a prototype name", '{"id":"a","type":"constructor","payload":{}}', "unknown_type", "a"],
    ["no id", '{"type":"ping","payload":{}}', "invalid_message", undefined],
    ["extra fields", '{"id":"a","type":"ping","payload":{"x":1}}', "invalid_message", "a"],
    ["a bad payload", '{"id":"a","type":"accept","payload":{}}', "invalid_message", "a"],
  ])("rejects %s without throwing", (_name, raw, code, id) => {
    const r = decode(raw);
    expect(r).toMatchObject({ ok: false, code });
    expect(r.ok ? undefined : r.id).toBe(id);
  });
});

describe("reference page", () => {
  it("matches the committed page (run `pnpm --filter @outstaff/protocol run docs:protocol`)", () => {
    const committed = readFileSync(
      new URL("../../../docs/src/content/docs/reference/agent-protocol.md", import.meta.url),
      "utf8",
    );

    expect(committed).toBe(renderProtocolReference());
  });

  it("lists every message", () => {
    const page = renderProtocolReference();
    for (const t of types) {
      expect(page).toContain(`### \`${t}\``);
    }
  });
});
