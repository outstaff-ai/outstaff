import { PortError } from "@outstaff/core";
import { z } from "zod";
import { defineVerb, result } from "./define.js";
import type { ToolStatus } from "#/tools/types.js";
import type { AgentEnv, NetworkAccess } from "./types.js";

const toolLine = (t: ToolStatus) =>
  t.state === "unavailable"
    ? `${t.name} ${t.version} UNAVAILABLE (${t.error})`
    : `${t.name} ${t.version}`;

const listOrNone = (items: string[], sep: string) => (items.length ? items.join(sep) : "none");

/** The services granted, as "http hub, http home". */
const networkLine = (http: NetworkAccess["http"]): string =>
  http.map((g) => `http ${g.name}`).join(", ");

/** The HTTP services granted to this person. */
const grantedHttp = (env: AgentEnv): NetworkAccess["http"] => env.network?.http ?? [];

/** Which of the team's integrations this process has connected. */
function connectedPorts(env: AgentEnv): Record<string, boolean> {
  return {
    tracker: env.tracker !== undefined,
    knowledge: env.knowledge !== undefined,
    vcs: env.vcs !== undefined,
    office: env.office !== undefined,
  };
}

export const me = defineVerb({
  name: "me",
  summary: "Show who you are on this team.",
  description:
    "Shows your handle, role, repository grants and which integrations this team has connected.",
  input: z.strictObject({}),
  args: [],
  examples: ["ost me"],
  async run(env) {
    const person = env.team.people.find((p) => p.handle === env.person);
    if (!person) {
      throw new PortError("not_found", `${env.person} is not a person of this team.`);
    }

    const grants = Object.entries(person.repos).map(([k, v]) => `${k}: ${v}`);
    const connected = connectedPorts(env);
    const tools = env.tools ?? [];
    const http = grantedHttp(env);
    const email = env.team.email?.pattern.replace("{handle}", person.handle);
    return result(
      [
        `${person.name} (${person.handle}), ${person.role} on ${env.team.team.name}`,
        ...(email ? [`Email: ${email}`] : []),
        `Repositories: ${listOrNone(grants, ", ")}`,
        `Tools: ${listOrNone(tools.map(toolLine), "; ")}`,
        `Network: ${networkLine(http) || "none"}`,
        `Connected: ${Object.entries(connected)
          .map(([k, v]) => `${k} ${v ? "yes" : "no"}`)
          .join(", ")}`,
      ],
      {
        handle: person.handle,
        name: person.name,
        role: person.role,
        team: env.team.team.name,
        email: email ?? null,
        repos: person.repos,
        tools,
        network: { http: http.map((g) => g.name) },
        connected,
      },
      [],
    );
  },
});
