import { MAX_IMAGE_BYTES, PortError, type Vcs } from "@outstaff/core";
import { basename } from "node:path";
import { z } from "zod";
import { mimetypeOf } from "./attachments.js";
import { defineVerb, result } from "./define.js";
import { readInputBytes } from "./files.js";
import { number, repo } from "./pr-write-support.js";
import { repoLabel, requireVcs } from "./support.js";
import type { AgentEnv } from "./types.js";
import { repoOrWorktree } from "./worktree.js";

/** The code host, when it can store images for pull requests. */
const canStoreImage = (vcs: Vcs): boolean => typeof vcs.storeImage === "function";

/** Markdown image text: brackets in the alt text and spaces in the link would end them early. */
const markdown = (alt: string, url: string) =>
  `![${alt.replaceAll(/[[\]\n]/g, " ").trim()}](${url.replaceAll(" ", "%20")})`;

/** The file's own name when it is one the runner downloaded (a ticket's or a chat message's), else the path's. */
function nameOf(env: AgentEnv, path: string): string {
  const known = [...Object.values(env.ticketFiles ?? {}).flat(), ...(env.attachments ?? [])];
  return known.find((f) => f.path === path)?.name ?? basename(path);
}

export const prAttach = defineVerb({
  name: "pr.attach",
  summary: "Store an image for a pull request and print the markdown that shows it.",
  description:
    "Stores an image (png, jpeg, gif or webp, up to 10 MB) for a pull request where the code host renders it, as you, and prints the markdown that shows it: put that in the description (pr update) or a comment (pr comment). An image hosted elsewhere, such as the tracker, does not render on the code host. The file is one in the scratch directory of this item or in the worktree. One with the same name for the same pull request replaces the earlier one. Needs a write grant on the repository and a code host that stores images.",
  input: z.strictObject({
    repo,
    number,
    path: z.string().min(1).max(1000).describe("Path of the image to attach."),
    alt: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Alt text of the image: what it shows. Default: the file name."),
  }),
  args: ["number", "path"],
  examples: [
    "ost pr attach 42 /scratch/w1/cart-empty.png",
    'ost pr attach 42 .scratch/cart.png --alt "Cart with a coupon applied"',
  ],
  async run(env, input, ctx) {
    const vcs = requireVcs(env);
    if (!canStoreImage(vcs)) {
      throw new PortError(
        "unsupported",
        "This code host does not store images for pull requests. Attach the image to the ticket instead (ost ticket attach).",
      );
    }

    const ref = await repoOrWorktree(env, ctx, input.repo);
    const data = readInputBytes(env, ctx, input.path, "image", MAX_IMAGE_BYTES);
    const name = nameOf(env, input.path);
    const stored = await vcs.storeImage!(ref, input.number, {
      name,
      mimetype: mimetypeOf(name),
      data,
    });

    const shown = markdown(input.alt ?? name, stored.url);
    const pr = vcs.links.pr(ref, input.number);
    return result(
      [
        `Stored ${name} for ${repoLabel(ref)}#${input.number} at ${stored.path}. Put this markdown in the description (pr update) or a comment (pr comment):`,
        shown,
        pr,
      ],
      { markdown: shown, url: stored.url, path: stored.path },
      [pr],
    );
  },
});
