import { z } from "zod";
import { CONFIG_CODES } from "./codes.js";
import { customIssue } from "./issues.js";
import type { Network, NetworkGrants } from "./types.js";

const d = (description: string) => ({ description });

const SLUG = /^[a-z][a-z0-9-]*$/;
const SECRET_KEY = /^[A-Za-z0-9_]+$/;

/** The origin of an http(s) URL (`https://hub.acme.example:8443`), or undefined for anything else. */
export function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** A grant names an origin only: scheme, host and optional port, with no credentials, path, query or fragment. */
function isOriginOnly(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.username === "" &&
      u.password === "" &&
      u.pathname === "/" &&
      u.search === "" &&
      u.hash === ""
    );
  } catch {
    return false;
  }
}

const name = (description: string) =>
  z
    .string()
    .min(1)
    .max(30)
    .regex(SLUG, "Use lowercase letters, digits and dashes, starting with a letter.")
    .meta(d(description));

const httpGrantSchema = z
  .strictObject({
    name: name("Name the agent gives to `ost http`, for example hub."),
    url: z
      .string()
      .refine(isOriginOnly, {
        message: "Use an origin only: http(s)://host[:port], with no credentials, path or query.",
        params: { code: CONFIG_CODES.networkInvalidUrl },
      })
      .meta(d("Origin of the service, for example https://hub.acme.example.")),
    token: z
      .string()
      .regex(SECRET_KEY, "Use a secret key: letters, digits and underscores.")
      .refine((v) => !v.startsWith("OUTSTAFF_"), {
        message: "OUTSTAFF_ keys belong to the framework and cannot be a service token.",
        params: { code: CONFIG_CODES.networkReservedToken },
      })
      .optional()
      .meta(
        d(
          "Key of a secret in this person's secrets; sent as `Authorization: Bearer <value>` to this service. The agent never sees the value.",
        ),
      ),
  })
  .meta(d("A service the agent may reach with `ost http`."));

export const networkSchema = z
  .strictObject({
    http: z.array(httpGrantSchema).optional().meta(d("Services reachable with `ost http`.")),
  })
  .superRefine((n, ctx) => {
    const seen = new Set<string>();
    n.http?.forEach((g, i) => {
      if (seen.has(g.name)) {
        ctx.addIssue(
          customIssue(
            CONFIG_CODES.networkDuplicateName,
            `The http grant name "${g.name}" is used twice.`,
            ["http", i, "name"],
          ),
        );
      }

      seen.add(g.name);
    });
  })
  .meta(
    d(
      "Network grants: the services the `ost http` verb reaches, with the token handled for the agent. They do not limit the network; the deployment's network policy does.",
    ),
  );

export const roleOverridesSchema = z
  .strictObject({
    network: networkSchema
      .optional()
      .meta(d("Network grants every person with this role gets, merged with their own.")),
  })
  .meta(d("Settings for everyone who plays this role."));

/**
 * The grants of a person: those of their role, then of the roles they extend, then their own. A later grant with
 * the same name replaces an earlier one.
 */
export function networkGrants(
  team: { roles?: Record<string, { network?: Network | undefined } | undefined> | undefined },
  person: { role: string; extends?: string[] | undefined; network?: Network | undefined },
): NetworkGrants {
  const roles = [person.role, ...(person.extends ?? [])];
  const layers = [...roles.map((r) => team.roles?.[r]?.network), person.network];

  return { http: latestByName(layers.map((layer) => layer?.http)) };
}

/** The grants of every layer, a later one replacing an earlier one with the same name. */
function latestByName<T extends { name: string }>(layers: (T[] | undefined)[]): T[] {
  const byName = new Map<string, T>();
  for (const g of layers.flatMap((layer) => layer ?? [])) {
    byName.set(g.name, g);
  }

  return [...byName.values()];
}

/** The secret keys the bearer tokens of these grants name. */
export const grantTokenKeys = (grants: NetworkGrants): string[] => [
  ...new Set(grants.http.flatMap((g) => (g.token ? [g.token] : []))),
];
