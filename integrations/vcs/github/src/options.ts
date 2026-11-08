import { z } from "zod";

export const githubOptions = z.strictObject({
  apiUrl: z
    .url()
    .default("https://api.github.com")
    .describe("REST API root; for GitHub Enterprise Server use https://<host>/api/v3."),
  webUrl: z.url().default("https://github.com").describe("Web root used for links."),
  graphqlUrl: z.url().optional().describe("GraphQL endpoint; derived from apiUrl when omitted."),
  assetsBranch: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/,
      "Use a plain branch name, such as outstaff-assets.",
    )
    .refine((b) => !b.includes("..") && !b.endsWith("/") && !b.endsWith(".lock"), {
      message: "Use a plain branch name, such as outstaff-assets.",
    })
    .default("outstaff-assets")
    .describe(
      "Branch that holds the images agents attach to pull requests (ost pr attach), at <pr number>/<file name>. Created as an orphan branch on the first image, so nothing reaches the default branch or its history.",
    ),
});
