import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PortError, type AdapterContext } from "@outstaff/core";
import { avatarsContract } from "@outstaff/core/contracts";
import {
  DEFAULT_STYLE,
  STYLES,
  STYLE_IDS,
  createDicebearAvatars,
  createDirectoryAvatars,
  createUrlAvatars,
  dicebearAvatars,
  dicebearOptions,
  directoryAvatars,
  directoryOptions,
  urlAvatars,
  urlOptions,
} from "../index.js";

const text = (data: Uint8Array) => new TextDecoder().decode(data);
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 16);

avatarsContract("dicebear", async () => ({
  subject: createDicebearAvatars(dicebearOptions.parse({})),
  seed: {},
  capabilities: dicebearAvatars.capabilities,
}));

avatarsContract("directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ost-avatars-"));
  await writeFile(join(dir, "sam.svg"), "<svg>sam</svg>");
  await writeFile(join(dir, "noor.png"), Buffer.from([137, 80, 78, 71]));
  return {
    subject: createDirectoryAvatars({ path: dir }),
    seed: {},
    capabilities: directoryAvatars.capabilities,
  };
});

const urlCtx = (fetchImpl: typeof fetch): AdapterContext<{ template: string }> =>
  ({
    options: { template: "https://img.example.test/{seed}.svg" },
    fetch: fetchImpl,
  }) as AdapterContext<{ template: string }>;

const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("missing")) {
    return new Response("no", { status: 404 });
  }

  if (url.includes("html")) {
    return new Response("<html/>", { headers: { "content-type": "text/html" } });
  }

  return new Response(`<svg>${url}</svg>`, { headers: { "content-type": "image/svg+xml" } });
};

avatarsContract("url", async () => ({
  subject: createUrlAvatars(urlCtx(fakeFetch)),
  seed: {},
  capabilities: urlAvatars.capabilities,
}));

describe("dicebear", () => {
  const render = (opts: object, seed = "sam", size?: number) =>
    createDicebearAvatars(dicebearOptions.parse(opts)).render(seed, size ? { size } : undefined);

  it("outputs SVG", async () => {
    const img = await render({});
    expect(img.mime).toBe("image/svg+xml");
    expect(text(img.data)).toMatch(/^<svg /);
  });

  it("is stable for a seed and differs between seeds (snapshot)", async () => {
    const a = await render({}, "sam");
    expect(sha(a.data)).toMatchInlineSnapshot(`"866e58ebd0c203d7"`);
    expect(text((await render({}, "noor")).data)).not.toBe(text(a.data));
  });

  it("makes no network calls", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network");
    }) as typeof fetch;

    try {
      expect(text((await render({ style: "identicon" })).data)).toMatch(/^<svg /);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("applies size and background", async () => {
    const svg = text((await render({ background: ["#b6e3f4"], size: 96 })).data);
    expect(svg).toContain('width="96"');
    expect(svg).toContain("b6e3f4");
    expect(text((await render({ size: 96 }, "sam", 48)).data)).toContain('width="48"');
  });

  it("renders every style in the collection", async () => {
    for (const id of STYLE_IDS) {
      expect(text((await render({ style: id })).data)).toMatch(/^<svg /);
    }
  });

  it("validates options", () => {
    expect(dicebearOptions.parse({}).style).toBe("notionists");
    expect(dicebearOptions.safeParse({ style: "pixel-art" }).success).toBe(true);
    expect(dicebearOptions.safeParse({ style: "nope" }).success).toBe(false);
    expect(dicebearOptions.safeParse({ background: ["red"] }).success).toBe(false);
    expect(dicebearOptions.safeParse({ background: [] }).success).toBe(false);
    expect(dicebearOptions.safeParse({ size: 4 }).success).toBe(false);
    expect(dicebearOptions.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("defaults to a style that needs no attribution", () => {
    const info = STYLES.get(DEFAULT_STYLE)!;
    expect(info.license).toBe("CC0 1.0");
    expect(info.permissive).toBe(true);
  });

  it("knows a license for every style", () => {
    for (const info of STYLES.values()) {
      expect(info.license).not.toBe("unknown");
    }

    expect(STYLES.get("adventurer")!.permissive).toBe(false);
  });
});

describe("directory", () => {
  it("prefers png over svg, and rejects unsafe or missing names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ost-avatars-"));
    await writeFile(join(dir, "sam.png"), Buffer.from([1, 2]));
    await writeFile(join(dir, "sam.svg"), "<svg/>");
    const avatars = createDirectoryAvatars({ path: dir });
    expect((await avatars.render("sam")).mime).toBe("image/png");
    await expect(avatars.render("../etc/passwd")).rejects.toMatchObject({ code: "invalid" });
    await expect(avatars.render("..")).rejects.toMatchObject({ code: "invalid" });
    await expect(avatars.render("ghost")).rejects.toBeInstanceOf(PortError);
    await expect(avatars.render("ghost")).rejects.toMatchObject({ code: "not_found" });
  });

  it("requires a path", () => {
    expect(directoryOptions.safeParse({}).success).toBe(false);
  });
});

describe("url", () => {
  it("maps statuses and content types to port errors", async () => {
    const avatars = createUrlAvatars(urlCtx(fakeFetch));
    await expect(avatars.render("missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(avatars.render("html")).rejects.toMatchObject({ code: "invalid" });
  });

  it("needs a {seed} template that is a URL", () => {
    expect(urlOptions.safeParse({ template: "https://x.test/{seed}.png" }).success).toBe(true);
    expect(urlOptions.safeParse({ template: "https://x.test/a.png" }).success).toBe(false);
    expect(urlOptions.safeParse({ template: "{seed}" }).success).toBe(false);
  });
});
