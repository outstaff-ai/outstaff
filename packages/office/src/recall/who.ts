import type { TeamConfig } from "@outstaff/core";

/** One person of the team: what they are shown as, and every name or id they may appear under. */
interface Known {
  shown: string;
  names: string[];
}

const valuesOf = (identities: Record<string, string | undefined> | undefined) =>
  Object.values(identities ?? {}).filter((v): v is string => typeof v === "string");

/** The trusted humans by name, the agents by handle, each with their identities in the integrations. */
function known(team: Pick<TeamConfig, "humans" | "people">): Known[] {
  return [
    ...(team.humans ?? []).map((h) => ({
      shown: h.name,
      names: [h.name, ...valuesOf(h.identities)],
    })),
    ...team.people.map((p) => ({
      shown: p.handle,
      names: [p.handle, p.name, ...valuesOf(p.identities)],
    })),
  ];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A name matches a person by any of their names or ids, or by the first word of their name ("Ada" for "Ada Admin"). */
const matches = (k: Known, text: string) =>
  k.names.some((n) => same(n, text) || same(n.split(/\s+/, 1)[0]!, text));

/** Who a moment is with, and how to show an actor, from the team file. */
export function people(team: Pick<TeamConfig, "humans" | "people">) {
  const all = known(team);
  return {
    /** Every name or id the person `--with` names may appear under in the history; the text itself when unknown. */
    namesOf(text: string): string[] {
      const found = all.filter((k) => matches(k, text));
      return [...new Set([text, ...found.flatMap((k) => k.names)])];
    },

    /** The actor as the team knows them: a human's name, an agent's handle, else as the integration named them. */
    shown(actor: string | null, name: string | null): string | undefined {
      const found =
        actor === null ? undefined : all.find((k) => k.names.some((n) => same(n, actor)));

      return found?.shown ?? name ?? actor ?? undefined;
    },
  };
}
