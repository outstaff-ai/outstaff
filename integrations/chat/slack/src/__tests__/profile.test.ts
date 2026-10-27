import { afterEach, describe, expect, it, vi } from "vitest";
import { formatWhen, homeView } from "#/profile.js";

afterEach(() => vi.restoreAllMocks());

const texts = (view: { blocks: Record<string, any>[] }) =>
  view.blocks.map((b) => b["text"]?.text ?? b["type"]);

describe("formatWhen", () => {
  it("names the viewer's zone", () => {
    expect(formatWhen("2026-01-01T12:00:00Z", "Europe/Berlin")).toMatch(/^1 Jan 2026, 13:00 /);
  });

  it("uses UTC with no zone, and for a zone name that is not valid", () => {
    expect(formatWhen("2026-01-01T12:00:00Z")).toBe("1 Jan 2026, 12:00 UTC");
    expect(formatWhen("2026-01-01T12:00:00Z", "Mars/Olympus")).toBe("1 Jan 2026, 12:00 UTC");
  });

  it("returns a time it cannot read as it was given", () => {
    expect(formatWhen("yesterday-ish", "Europe/Berlin")).toBe("yesterday-ish");
  });

  it("falls back to the zone's own name when the runtime offers no short name for it", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function () {
      return {
        formatToParts: () => [{ type: "literal", value: "noon" }],
      } as unknown as Intl.DateTimeFormat;
    });

    expect(formatWhen("2026-01-01T12:00:00Z", "Europe/Berlin")).toBe("noon Europe/Berlin");
  });
});

describe("homeView", () => {
  it("clips a name over 150 characters and a section over 3000", () => {
    const view = homeView({
      name: "n".repeat(200),
      role: "developer",
      status: "idle",
      hint: "h".repeat(4000),
    });

    const header = view.blocks[0]!["text"] as { text: string };
    expect(header.text).toHaveLength(150);
    expect(header.text.endsWith("…")).toBe(true);
    const hint = view.blocks[3]!["text"] as { text: string };
    expect(hint.text).toHaveLength(3000);
    expect(hint.text.endsWith("…")).toBe(true);
  });

  it("shows description and model, and a paused agent as paused", () => {
    const view = homeView({
      name: "Sam",
      role: "dev <lead>",
      description: "Owns checkout",
      model: "model-1",
      status: "paused",
    });

    expect(texts(view)).toEqual([
      "Sam",
      "*dev &lt;lead&gt;*\nOwns checkout\n_Model: model-1_",
      ":double_vertical_bar: *Paused*",
    ]);
  });

  it("names the work without a link when its address is not http(s), and ignores work while idle", () => {
    const base = { name: "Sam", role: "dev" } as const;
    const unsafe = homeView({
      ...base,
      status: "working",
      current: { title: "ACME-1", url: "javascript:alert(1)" },
    });

    expect(texts(unsafe)[2]).toBe(":large_green_circle: *Working on* ACME-1");
    const untitled = homeView({ ...base, status: "working", current: { title: "ACME-2" } });
    expect(texts(untitled)[2]).toBe(":large_green_circle: *Working on* ACME-2");
    const idle = homeView({ ...base, status: "idle", current: { title: "ACME-3" } });
    expect(texts(idle)[2]).toBe(":white_circle: *Idle*");
  });

  it("says a section is empty when it has no lines, and shows at most 40 sections", () => {
    const sections = Array.from({ length: 45 }, (_, i) => ({ heading: `S${i}`, lines: [] }));
    const view = homeView({ name: "Sam", role: "dev", status: "idle", sections });
    expect(texts(view)[4]).toBe("*S0*\n_Nothing._");
    expect(view.blocks.filter((b) => b["type"] === "divider")).toHaveLength(40);
  });
});
