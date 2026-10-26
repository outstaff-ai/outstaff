import { PortError, type AdapterContext } from "@outstaff/core";
import { z } from "zod";

const connection = {
  url: z.url().describe("Web address of the instance, used for links."),
  api_url: z
    .url()
    .optional()
    .describe("API root; defaults to the web address with `api.` in front of the host."),
  project: z
    .string()
    .min(1)
    .describe("Project key, or `<team>.<KEY>` when the key is not unique across your teams."),
  ca_file: z
    .string()
    .min(1)
    .optional()
    .describe("PEM file with the CA that signed a self-hosted instance's certificate."),
  agents: z
    .array(z.string().min(1))
    .default([])
    .describe("Usernames of members that are agents, in addition to the team's people handles."),
  issue_url: z
    .string()
    .optional()
    .describe(
      "Link template for issues; `{url}`, `{workspace}`, `{project}` and `{key}` are replaced; default `{url}/{workspace}/issue/{key}`.",
    ),
  doc_url: z
    .string()
    .optional()
    .describe(
      "Link template for documents; `{url}`, `{workspace}`, `{project}` and `{id}` are replaced; default `{url}/{workspace}/{project}/docs/{id}`.",
    ),
};

export const trackerOptions = z.strictObject(connection);

/** Every option is optional here: it falls back to the tracker integration when that is Its a Plan too. */
export const knowledgeOptions = z.strictObject({
  url: connection.url.optional(),
  api_url: connection.api_url,
  project: connection.project.optional(),
  ca_file: connection.ca_file,
  agents: connection.agents,
  issue_url: connection.issue_url,
  doc_url: connection.doc_url,
});

export type TrackerOptions = z.output<typeof trackerOptions>;
export type KnowledgeOptions = z.output<typeof knowledgeOptions>;

export interface Connection extends TrackerOptions {
  api_url: string;
}

export function deriveApiUrl(url: string): string {
  const u = new URL(url);
  u.hostname = `api.${u.hostname}`;
  return u.origin;
}

/** The options a knowledge adapter runs with: its own, completed from the tracker integration when that is Its a Plan. */
export function resolveConnection(
  ctx: Pick<AdapterContext<unknown>, "team">,
  own: KnowledgeOptions | TrackerOptions,
): Connection {
  const tracker = (ctx.team?.integrations as Record<string, unknown> | undefined)?.["tracker"] as
    | ({ adapter?: string } & Record<string, unknown>)
    | undefined;

  const { adapter: _adapter, ...trackerRest } = tracker ?? {};
  const fallback =
    tracker?.adapter === "itsaplan" ? trackerOptions.partial().safeParse(trackerRest) : undefined;

  const base = fallback?.success ? fallback.data : {};
  const merged = {
    ...base,
    ...Object.fromEntries(Object.entries(own).filter(([, v]) => v !== undefined)),
  } as Partial<TrackerOptions>;

  if (!merged.url || !merged.project) {
    throw new PortError(
      "invalid",
      "Its a Plan needs `url` and `project`; set them on this integration or on a tracker that uses itsaplan.",
    );
  }

  return {
    ...merged,
    url: merged.url,
    project: merged.project,
    agents: [...new Set([...(base.agents ?? []), ...(merged.agents ?? [])])],
    api_url: (merged.api_url ?? deriveApiUrl(merged.url)).replace(/\/+$/, ""),
  };
}
