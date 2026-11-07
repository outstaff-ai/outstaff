import { describe, expect, it } from "vitest";
import {
  linkMessageSchema,
  PAYLOAD_SCHEMAS,
  requestSchema,
  RESULT_SCHEMAS,
} from "#/link/schemas.js";

describe("the exported schema maps", () => {
  it("hold one payload schema per message type, the one the message is parsed with", () => {
    for (const option of linkMessageSchema.options) {
      const type = option.shape.type.value;

      expect(PAYLOAD_SCHEMAS[type]).toBe(option.shape.payload);
    }

    expect(Object.keys(PAYLOAD_SCHEMAS)).toHaveLength(linkMessageSchema.options.length);
  });

  it("hold one result schema per request method", () => {
    expect(Object.keys(RESULT_SCHEMAS).toSorted()).toEqual(
      requestSchema.options.map((o) => o.shape.method.value).toSorted(),
    );
  });

  it("parse a result on their own", () => {
    expect(RESULT_SCHEMAS.event.safeParse({ trace: {} }).success).toBe(false);
    expect(
      PAYLOAD_SCHEMAS.hello.parse({ office: { team: "acme", version: "1.0.0" } }).office.team,
    ).toBe("acme");
  });
});
