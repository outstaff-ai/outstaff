import { describe, expect, it, vi } from "vitest";

// A style that ships without credits or a license must not be taken for one that needs no attribution.
vi.mock("@dicebear/collection", () => ({
  bareStyle: { create: () => ({}) },
  creditedStyle: {
    meta: { creator: "Acme Studio", license: { name: "CC0 1.0" } },
    create: () => ({}),
  },
  namelessLicenseStyle: { meta: { creator: "Acme Studio", license: {} }, create: () => ({}) },
}));

const { STYLES, STYLE_IDS } = await import("#/styles.js");

describe("styles from a collection with incomplete metadata", () => {
  it("names styles in kebab case", () => {
    expect(STYLE_IDS).toEqual(["bare-style", "credited-style", "nameless-license-style"]);
  });

  it("marks a style with no metadata as unknown and not permissive", () => {
    expect(STYLES.get("bare-style")).toMatchObject({
      creator: "unknown",
      license: "unknown",
      permissive: false,
    });
  });

  it("marks a style with credits but no license name as unknown and not permissive", () => {
    expect(STYLES.get("nameless-license-style")).toMatchObject({
      creator: "Acme Studio",
      license: "unknown",
      permissive: false,
    });
  });

  it("keeps the creator and license of a complete style", () => {
    expect(STYLES.get("credited-style")).toMatchObject({
      creator: "Acme Studio",
      license: "CC0 1.0",
      permissive: true,
    });
  });
});
