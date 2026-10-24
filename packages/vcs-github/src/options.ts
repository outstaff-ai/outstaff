import { z } from "zod";

export const githubOptions = z.strictObject({
  apiUrl: z
    .url()
    .default("https://api.github.com")
    .describe("REST API root; for GitHub Enterprise Server use https://<host>/api/v3."),
  webUrl: z.url().default("https://github.com").describe("Web root used for links."),
  graphqlUrl: z.url().optional().describe("GraphQL endpoint; derived from apiUrl when omitted."),
});

export type GithubOptions = z.output<typeof githubOptions>;
