import { describe, expect, it } from "vitest";
import { ftsQuery } from "#/store/sql/fts-query.js";

describe("a search as SQLite FTS5 reads it", () => {
  it("quotes every term, so nothing written is query syntax", () => {
    expect(ftsQuery('cart "session store" NEAR(x) a"b')).toBe(
      '"cart" "session store" "NEAR(x)" "a" "b"',
    );
  });

  it("keeps or between two terms, and puts exclusions last", () => {
    expect(ftsQuery("-old cart or session -stale")).toBe(
      '"cart" OR "session" NOT "old" NOT "stale"',
    );

    expect(ftsQuery("or cart or")).toBe('"cart"');
    expect(ftsQuery('"or" cart')).toBe('"or" "cart"');
  });

  it("matches nothing when no term is wanted", () => {
    expect(ftsQuery("")).toBeUndefined();
    expect(ftsQuery('"" *:^ -cart')).toBeUndefined();
  });
});
