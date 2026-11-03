import { describe, expect, it } from "vitest";
import { excerpt } from "#/recall/excerpt.js";

const words = (n: number, word = "filler") => Array.from({ length: n }, () => word).join(" ");

describe("a moment's excerpt", () => {
  it("keeps a short text whole, on one line", () => {
    expect(excerpt("Keep the\n\ngreetings   short.", "greeting")).toBe("Keep the greetings short.");
  });

  it("cuts a long text around the first match, in any form, and marks the cuts", () => {
    const text = `${words(40)} the greetings stay short ${words(40)}`;
    const cut = excerpt(text, "greeting -filler or", 80);
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).toContain("the greetings stay short");
    expect(cut.length).toBeLessThanOrEqual(82);
  });

  it("starts at the beginning when nothing in the text is a search word", () => {
    const cut = excerpt(`start ${words(60)}`, '"nowhere"', 50);
    expect(cut.startsWith("start filler")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("ends at the end of the text when the match is near it", () => {
    const cut = excerpt(`${words(60)} greetings`, "greetings", 50);
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.endsWith("greetings")).toBe(true);
  });
});
