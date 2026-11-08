import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, PortError, imageFileName } from "#/ports/index.js";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p)] : p)));

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const refusal = (image: Parameters<typeof imageFileName>[0]) => {
  try {
    imageFileName(image);
  } catch (e) {
    expect(e).toBeInstanceOf(PortError);
    expect((e as PortError).code).toBe("invalid");
    return (e as PortError).message;
  }

  throw new Error("not refused");
};

describe("imageFileName", () => {
  it("takes the four image types by their bytes and keeps a safe name", () => {
    expect(imageFileName({ name: "shot.png", mimetype: "image/png", data: PNG })).toBe("shot.png");
    expect(
      imageFileName({
        name: "a/b/Photo 1.JPG",
        mimetype: "image/jpeg",
        data: bytes([0xff, 0xd8, 0xff]),
      }),
    ).toBe("Photo-1.JPG");

    expect(
      imageFileName({ name: "x.jpeg", mimetype: "image/jpeg", data: bytes([0xff, 0xd8, 0xff]) }),
    ).toBe("x.jpeg");

    expect(
      imageFileName({ name: "..\\..\\loop.gif", mimetype: "image/gif", data: bytes("GIF89a") }),
    ).toBe("loop.gif");

    expect(
      imageFileName({
        name: "w.webp",
        mimetype: "image/webp",
        data: bytes("RIFF", [0, 0, 0, 0], "WEBP"),
      }),
    ).toBe("w.webp");
  });

  it("refuses other types, bytes that are not the type, a name without its extension and a file over the cap", () => {
    expect(refusal({ name: "a.svg", mimetype: "image/svg+xml", data: bytes("<svg/>") })).toMatch(
      /png, jpeg, gif or webp/,
    );

    refusal({ name: "a.png", mimetype: "image/png", data: bytes("text") });
    refusal({ name: "a.webp", mimetype: "image/webp", data: bytes("RIFF", [0, 0, 0, 0], "WAVE") });
    expect(refusal({ name: "a.gif", mimetype: "image/png", data: PNG })).toMatch(/end in \.png/);
    expect(refusal({ name: "png", mimetype: "image/png", data: PNG })).toMatch(/end in \.png/);
    expect(refusal({ name: "a.jpg", mimetype: "image/jpeg", data: PNG })).toMatch(/not an image/);
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG);
    expect(refusal({ name: "big.png", mimetype: "image/png", data: big })).toMatch(/10 MB/);
  });
});
