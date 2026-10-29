import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MESSAGE_META,
  PROTOCOL_VERSION,
  decode,
  encode,
  messageSchema,
  renderProtocolReference,
} from "#/index.js";

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
    const m = {
      id: "1",
      type: "accept",
      payload: { workItemId: "w1", runtime: "claude" },
    } as const;

    expect(decode(encode(m))).toEqual({ ok: true, message: m });
  });

  it("carries the metadata of a chat message's files, and a message that only shares files", () => {
    const base = {
      messageId: "m1",
      channel: "D1",
      text: "",
      author: { id: "U1" },
      direct: true,
      participant: true,
    };

    const file = {
      id: "F1",
      name: "screen.png",
      mimetype: "image/png",
      size: 10,
      url: "https://f.example/F1",
    };

    const m = { id: "1", type: "chat_message" as const, payload: { ...base, files: [file] } };
    expect(decode(encode(m))).toEqual({ ok: true, message: m });
    expect(
      decode(encode({ ...m, payload: { ...base, files: [{ ...file, data: "AAAA" }] } } as never))
        .ok,
    ).toBe(false);

    expect(
      decode(
        encode({
          ...m,
          payload: { ...base, files: Array.from({ length: 11 }, () => file) },
        } as never),
      ).ok,
    ).toBe(false);
  });

  it("carries usage windows and refuses malformed ones", () => {
    const windows = [{ name: "five_hour", utilization: 0.4, resetsAt: "2030-01-01T05:00:00Z" }];
    const m = { id: "1", type: "usage", payload: { windows } } as const;
    expect(decode(encode(m))).toEqual({ ok: true, message: m });
    expect(
      decode('{"id":"1","type":"usage","payload":{"windows":[{"name":"x","utilization":-1}]}}'),
    ).toMatchObject({ ok: false, code: "invalid_message" });
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
      new URL("../../../../docs/src/content/docs/reference/agent-protocol.md", import.meta.url),
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
