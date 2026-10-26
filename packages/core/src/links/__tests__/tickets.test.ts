import { describe, expect, it } from "vitest";
import { createFakeTracker } from "../../fakes/tracker.js";
import { createTicketLinker, ticketProjectKeys } from "../tickets.js";

const team = (project?: unknown) =>
  ({
    integrations: { tracker: { adapter: "fake", ...(project === undefined ? {} : { project }) } },
  }) as never;

const tracker = createFakeTracker({ keyPrefix: "ACME" });
const url = (key: string) => tracker.links.issue(key);
const linker = createTicketLinker(team("ACME"), tracker);

describe("ticket links", () => {
  it("links a bare key to the tracker", () => {
    expect(linker.format("Fixed in ACME-45, thanks.", "chat")).toBe(
      `Fixed in [ACME-45](${url("ACME-45")}), thanks.`,
    );

    expect(linker.format("ACME-1 and ACME-2", "tracker")).toBe(
      `[ACME-1](${url("ACME-1")}) and [ACME-2](${url("ACME-2")})`,
    );
  });

  it("rewrites a link whose text is a key but whose URL is not the tracker's", () => {
    const wrong = "[ACME-45](https://github.com/acme/app/issues/acme-45)";
    for (const surface of ["chat", "tracker", "host"] as const) {
      expect(linker.format(`See ${wrong}.`, surface)).toBe(`See [ACME-45](${url("ACME-45")}).`);
    }

    expect(linker.format("[acme-7](https://acme.example/x)", "host")).toBe(
      `[ACME-7](${url("ACME-7")})`,
    );
  });

  it("keeps a correct link and does not nest links in link text", () => {
    const ok = `[ACME-45](${url("ACME-45")})`;
    expect(linker.format(ok, "chat")).toBe(ok);
    expect(linker.format("[ACME-45 Fix cart](https://acme.example/p)", "chat")).toBe(
      "[ACME-45 Fix cart](https://acme.example/p)",
    );
  });

  it("on the code host leaves bare keys to GitHub's autolinks", () => {
    expect(linker.format("Closes ACME-45", "host")).toBe("Closes ACME-45");
    expect(linker.format("`x` ACME-45 https://acme.example/a me@acme.example", "host")).toBe(
      "`x` ACME-45 https://acme.example/a me@acme.example",
    );
  });

  it("leaves code, URLs and emails untouched", () => {
    const text = [
      "Run `ost ticket show ACME-45` now",
      "```",
      "ACME-46",
      "```",
      "https://acme.example/browse/ACME-47 <https://acme.example/ACME-48>",
      "mail ACME-49@acme.example",
      "path src/ACME-50/x",
    ].join("\n");

    expect(linker.format(text, "chat")).toBe(text);
  });

  it("links keys around code but not inside it", () => {
    expect(linker.format("ACME-1 `ACME-2` ACME-3", "chat")).toBe(
      `[ACME-1](${url("ACME-1")}) \`ACME-2\` [ACME-3](${url("ACME-3")})`,
    );
  });

  it("leaves the text unchanged without a tracker or a project key", () => {
    const text = "ACME-45 [ACME-45](https://github.com/acme/app/issues/45)";

    expect(createTicketLinker(team("ACME"), undefined).format(text, "chat")).toBe(text);
    expect(createTicketLinker(team(), tracker).format(text, "chat")).toBe(text);
  });

  it("leaves a key of another project alone", () => {
    const text = "SHOP-3 [SHOP-3](https://github.com/acme/app/issues/3) ACMEX-1 XACME-1 acme-5";
    expect(linker.format(text, "chat")).toBe(text);
  });

  it("takes several projects, and the key part of <team>.<KEY>", () => {
    expect(ticketProjectKeys(team(["ACME", "web.shop"]))).toEqual(["ACME", "SHOP"]);
    const both = createTicketLinker(team(["ACME", "web.shop"]), tracker);
    expect(both.format("SHOP-3", "chat")).toBe(`[SHOP-3](${url("SHOP-3")})`);
  });
});

describe("guard for links on the tracker's host", () => {
  const plain = {
    links: { issue: (key: string) => `https://tracker.acme.example/acme/issue/${key}` },
  } as never;

  const guarded = createTicketLinker(team("ACME"), plain);

  it("replaces a made-up tracker URL with the canonical link of the ticket it names", () => {
    expect(
      guarded.format("See https://tracker.acme.example/ACME-111#comment-1740.", "tracker"),
    ).toBe("See https://tracker.acme.example/acme/issue/ACME-111.");

    expect(
      guarded.format("[the comment](https://tracker.acme.example/browse/ACME-7)", "chat"),
    ).toBe("[the comment](https://tracker.acme.example/acme/issue/ACME-7)");
  });

  it("drops a fragment from an issue link when the tracker has no comment anchors", () => {
    expect(
      guarded.format("https://tracker.acme.example/acme/issue/ACME-111#comment-1740", "host"),
    ).toBe("https://tracker.acme.example/acme/issue/ACME-111");
  });

  it("keeps canonical links, comment links of a tracker with anchors, and other hosts", () => {
    const own = "https://tracker.acme.example/acme/issue/ACME-5";
    expect(guarded.format(`${own} and <${own}>`, "chat")).toBe(`${own} and <${own}>`);
    const comment = tracker.links.comment!("ACME-5", "c1");
    expect(linker.format(`See ${comment}`, "chat")).toBe(`See ${comment}`);
    const other = "https://github.com/acme/app/issues/5#issuecomment-1";
    expect(guarded.format(other, "chat")).toBe(other);
  });

  it("flags a URL that names no ticket, and leaves documents of the knowledge base alone", () => {
    const flags: string[] = [];
    const knowledge = {
      links: {
        doc: (id: string) =>
          `https://tracker.acme.example/acme/SHOP/docs/${encodeURIComponent(id)}`,
      },
    } as never;

    const g = createTicketLinker(team("ACME"), plain, { knowledge, flag: (m) => flags.push(m) });
    const doc = "https://tracker.acme.example/acme/SHOP/docs/3";
    const odd = "https://tracker.acme.example/some/page";
    expect(g.format(`${doc} ${odd}`, "chat")).toBe(`${doc} ${odd}`);
    expect(flags).toEqual([`Link not built by outstaff on tracker.acme.example: ${odd}`]);
  });
});
