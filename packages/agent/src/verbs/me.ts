import { PortError } from "@outstaff/core";
import { z } from "zod";
import { defineVerb, result } from "./define.js";

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
    const connected = {
      tracker: env.tracker !== undefined,
      knowledge: env.knowledge !== undefined,
      vcs: env.vcs !== undefined,
      office: env.office !== undefined,
    };

    const tools = env.tools ?? [];
    const toolLine = (t: (typeof tools)[number]) =>
      t.state === "unavailable"
        ? `${t.name} ${t.version} UNAVAILABLE (${t.error})`
        : `${t.name} ${t.version}`;

    const http = env.network?.http ?? [];
    const adb = env.network?.adb ?? [];
    const networkLine = [
      ...http.map((g) => `http ${g.name}`),
      ...adb.map((g) => `adb ${g.name}${g.pairing ? " (wireless)" : ""}`),
    ].join(", ");

    const email = env.team.email?.pattern.replace("{handle}", person.handle);
    return result(
      [
        `${person.name} (${person.handle}), ${person.role} on ${env.team.team.name}`,
        ...(email ? [`Email: ${email}`] : []),
        `Repositories: ${grants.length ? grants.join(", ") : "none"}`,
        `Tools: ${tools.length ? tools.map(toolLine).join("; ") : "none"}`,
        `Network: ${networkLine || "none"}`,
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
        network: { http: http.map((g) => g.name), adb: adb.map((g) => g.name) },
        connected,
      },
      [],
    );
  },
});
