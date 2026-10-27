import { expect, it } from "vitest";
import type { Avatars } from "../ports/index.js";
import { contractSuite, requireCapability } from "./harness.js";
import type { ContractSetupFn } from "./types.js";

export function avatarsContract(
  name: string,
  setup: ContractSetupFn<Avatars, Record<string, never>>,
): void {
  contractSuite(`avatars contract: ${name}`, setup, (get) => {
    it("renders an image with a known mime type", async (t) => {
      const s = get();
      requireCapability(t, s, "avatars.generate");
      const img = await s.subject.render("sam");
      expect(["image/svg+xml", "image/png"]).toContain(img.mime);
      expect(img.data.byteLength).toBeGreaterThan(0);
    });

    it("is deterministic per seed and differs between seeds", async (t) => {
      const s = get();
      requireCapability(t, s, "avatars.generate");
      const a1 = await s.subject.render("sam", { size: 64 });
      const a2 = await s.subject.render("sam", { size: 64 });
      const b = await s.subject.render("noor", { size: 64 });
      expect(Buffer.from(a1.data).equals(Buffer.from(a2.data))).toBe(true);
      expect(Buffer.from(a1.data).equals(Buffer.from(b.data))).toBe(false);
    });
  });
}
