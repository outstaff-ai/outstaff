import type { AdapterRegistry } from "@outstaff/core";

export const SECRETS_BEGIN = "<!-- contract:secrets:begin (generated, do not edit by hand) -->";
export const SECRETS_END = "<!-- contract:secrets:end -->";

type Container = "office" | "agent" | "both";

interface Row {
  key: string;
  container: Container;
  optional: boolean;
  conditional: boolean;
  derivable: boolean;
  visible: boolean;
  text: string;

  /** Already markdown; not escaped. */
  markdown?: boolean;
  office?: string;
  agent?: string;
}

/**
 * The runtime credential the Claude Code binary documents no way to hide from its Bash tool: it has to stay in the
 * environment of the process (see the runtime adapter's known limits). Every other key is scrubbed.
 */
const AGENT_VISIBLE = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/** Secrets the framework itself reads; no adapter declares them. */
const CORE_ROWS: Row[] = [
  {
    key: "OUTSTAFF_AGENT_TOKEN_<HANDLE>",
    container: "office",
    optional: false,
    conditional: false,
    derivable: false,
    visible: false,
    markdown: true,
    text: "One token per person, so the office accepts that agent's connection. The handle is upper case with `-` as `_`. Choose a long random value and give the same value to that agent as `OUTSTAFF_AGENT_TOKEN`.",
  },
  {
    key: "OUTSTAFF_LINK_TOKEN",
    container: "office",
    optional: true,
    conditional: false,
    derivable: false,
    visible: false,
    markdown: true,
    text: "Proposed (decision 0016). The bearer token the office connects with to the monitoring or management service its office link names (`link.url` in the team file). Without it, or without the URL, the office connects to none. The service gives it out for the office.",
  },
  {
    key: "OUTSTAFF_AGENT_TOKEN",
    container: "agent",
    optional: false,
    conditional: false,
    derivable: false,
    visible: false,
    markdown: true,
    text: "This person's token for the office, the same value the office holds as `OUTSTAFF_AGENT_TOKEN_<HANDLE>`.",
  },
];

const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("<", "&lt;");

const yes = (b: boolean) => (b ? "yes" : "no");

const sentence = (description: string, where: string, when?: string) =>
  `${description.replace(/\.$/, "")}. ${where.replace(/\.$/, "")}.${when ? ` Needed when ${when.replace(/\.$/, "")}.` : ""}`;

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, 3, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`;

  return [line(header), `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`, ...rows.map(line)];
}

/** The per-secret table, from what each registered adapter declares for the two scopes. */
export function renderSecretsTable(office: AdapterRegistry, agent: AdapterRegistry): string {
  const found = new Map<string, Row>();
  const note = (registry: AdapterRegistry, scope: "office" | "person") => {
    for (const def of registry.list()) {
      for (const s of def.secrets(scope)) {
        const side = scope === "office" ? "office" : "agent";
        const prev = found.get(s.key);
        const text = sentence(s.description, s.where, s.when);
        found.set(s.key, {
          ...prev,
          key: s.key,
          container: prev && prev.container !== side ? "both" : side,
          optional: (prev?.optional ?? true) && (s.optional ?? false),
          conditional: (prev?.conditional ?? true) && s.when !== undefined,
          derivable: s.derivable ?? false,
          visible: AGENT_VISIBLE.has(s.key),
          text,
          [side]: text,
        });
      }
    }
  };

  note(office, "office");
  note(agent, "person");

  // A key declared as required by either side is required; text that differs per side is shown for both.
  const merged = [...found.values()].map((r) => ({
    ...r,
    text:
      r.office && r.agent && r.office !== r.agent
        ? `Office: ${r.office} Agent: ${r.agent}`
        : (r.agent ?? r.office ?? r.text),
  }));

  const rows = [...CORE_ROWS, ...merged.toSorted((a, b) => a.key.localeCompare(b.key))];
  return table(
    [
      "Key",
      "Container",
      "Required",
      "Derivable",
      "Agent shell can see it",
      "What it is and where to get it",
    ],
    rows.map((r) => [
      `\`${r.key}\``,
      r.container,
      r.optional ? "optional" : r.conditional ? "conditional" : "required",
      yes(r.derivable),
      yes(r.visible),
      r.markdown ? r.text : cell(r.text),
    ]),
  ).join("\n");
}

export function renderSecretsBlock(office: AdapterRegistry, agent: AdapterRegistry): string {
  return `${SECRETS_BEGIN}\n\n${renderSecretsTable(office, agent)}\n\n${SECRETS_END}`;
}

/** The page with its generated block replaced. */
export function applySecretsBlock(page: string, block: string): string {
  const start = page.indexOf(SECRETS_BEGIN);
  const end = page.indexOf(SECRETS_END);
  if (start < 0 || end < start) {
    throw new Error(`The page has no ${SECRETS_BEGIN} ... ${SECRETS_END} block.`);
  }

  return page.slice(0, start) + block + page.slice(end + SECRETS_END.length);
}
