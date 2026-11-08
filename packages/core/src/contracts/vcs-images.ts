import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES } from "#/ports/index.js";
import { expectAbsoluteUrl, expectPortError, requireCapability, requireSeed } from "./harness.js";
import type { VcsCases } from "./types.js";

/** The smallest valid PNG header, followed by `fill`, so two images of one name differ. */
const png = (fill: number) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, fill]);

/** Images stored for a pull request, where the host's markdown renders them (`vcs.images`). */
export function vcsImageCases({ get, repoOf }: VcsCases): void {
  describe("images on pull requests", () => {
    const setup = async (t: Parameters<typeof requireSeed>[0], level: "write" | "read") => {
      const s = get();
      requireCapability(t, s, "vcs.pullRequests", "vcs.images");
      const self = s.seed.selfLogin;
      if (!self) {
        t.skip("seed.selfLogin not provided");
      }

      const repo = repoOf(t, s);
      await requireSeed(t, s.seed, "permission")(repo, self!, level);
      const pr = await requireSeed(t, s.seed, "pullRequest")(repo, { title: "Shows a page" });
      const stored = requireSeed(t, s.seed, "storedImage");
      return { s, repo, pr, stored };
    };

    it("stores an image for a pull request, adds more, and replaces one of the same name", async (t) => {
      const { s, repo, pr, stored } = await setup(t, "write");
      const store = s.subject.storeImage!.bind(s.subject);
      const first = await store(repo, pr.number, {
        name: "home page.png",
        mimetype: "image/png",
        data: png(1),
      });

      expectAbsoluteUrl(first.url);
      expect(first.path).toBe(`${pr.number}/home-page.png`);
      expect(first.url).toContain("home-page.png");

      const second = await store(repo, pr.number, {
        name: "cart.png",
        mimetype: "image/png",
        data: png(2),
      });

      expect(second.path).toBe(`${pr.number}/cart.png`);
      await store(repo, pr.number, { name: "home page.png", mimetype: "image/png", data: png(3) });
      expect([...(await stored(repo, pr.number, "home-page.png"))!.data]).toEqual([...png(3)]);
      expect([...(await stored(repo, pr.number, "cart.png"))!.data]).toEqual([...png(2)]);
    });

    it("refuses a file that is not an image, a mismatched name, one too large, and an unknown pull request", async (t) => {
      const { s, repo, pr, stored } = await setup(t, "write");
      const store = s.subject.storeImage!.bind(s.subject);
      const refused = [
        { name: "notes.txt", mimetype: "text/plain", data: new Uint8Array([104, 105]) },
        { name: "fake.png", mimetype: "image/png", data: new Uint8Array([104, 105]) },
        { name: "shot.svg", mimetype: "image/png", data: png(1) },
        { name: "big.png", mimetype: "image/png", data: new Uint8Array(MAX_IMAGE_BYTES + 1) },
      ];

      refused[3]!.data.set(png(1));
      for (const image of refused) {
        await expectPortError(store(repo, pr.number, image), "invalid");
      }

      expect(await stored(repo, pr.number, "fake.png")).toBeUndefined();
      await expectPortError(
        store(repo, 99999, { name: "a.png", mimetype: "image/png", data: png(1) }),
        "not_found",
      );
    });

    it("refuses without a write grant", async (t) => {
      expect.hasAssertions();
      const { s, repo, pr } = await setup(t, "read");
      await expectPortError(
        s.subject.storeImage!(repo, pr.number, {
          name: "a.png",
          mimetype: "image/png",
          data: png(1),
        }),
        "forbidden",
      );
    });
  });
}
