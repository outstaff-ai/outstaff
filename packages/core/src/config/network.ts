import { z } from "zod";
import { CONFIG_CODES } from "./codes.js";
import { customIssue } from "./issues.js";

const d = (description: string) => ({ description });

const SLUG = /^[a-z][a-z0-9-]*$/;
const SECRET_KEY = /^[A-Za-z0-9_]+$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

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

const adbGrantSchema = z
  .strictObject({
    name: name("Name the agent gives to `ost adb`, for example test-tablet."),
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(HOST, "Use a host name or an IP address, without scheme or port.")
      .meta(d("Host name or IP address of the device, for example 10.0.0.16.")),
    port: z
      .int()
      .min(1)
      .max(65535)
      .optional()
      .meta(d("Fixed adb port, for example 5555 (adb over TCP). Omit for wireless pairing.")),
    pairing: z
      .literal("wireless")
      .optional()
      .meta(
        d(
          "Android 11+ wireless debugging: the connect port is random and changes, so a human supplies it. Use instead of port.",
        ),
      ),
  })
  .refine((g) => (g.port === undefined) !== (g.pairing === undefined), {
    message: "Give either a port (adb over TCP) or pairing: wireless, not both and not neither.",
    params: { code: CONFIG_CODES.networkAdbMode },
  })
  .meta(d("An Android device the agent may reach with `ost adb`."));

export const networkSchema = z
  .strictObject({
    http: z.array(httpGrantSchema).optional().meta(d("Services reachable with `ost http`.")),
    adb: z.array(adbGrantSchema).optional().meta(d("Devices reachable with `ost adb`.")),
    raw_http: z
      .boolean()
      .optional()
      .meta(
        d(
          "Also let the agent run `curl` against the origins in `http`. Off by default. `curl` sends no token.",
        ),
      ),
  })
  .superRefine((n, ctx) => {
    for (const key of ["http", "adb"] as const) {
      const seen = new Set<string>();
      n[key]?.forEach((g, i) => {
        if (seen.has(g.name)) {
          ctx.addIssue(
            customIssue(
              CONFIG_CODES.networkDuplicateName,
              `The ${key} grant name "${g.name}" is used twice.`,
              [key, i, "name"],
            ),
          );
        }

        seen.add(g.name);
      });
    }
  })
  .meta(
    d(
      "Network grants: the services and devices an agent may reach. Everything else stays denied. The deployment must also allow the network path.",
    ),
  );

export type Network = z.output<typeof networkSchema>;
export type HttpGrant = NonNullable<Network["http"]>[number];
export type AdbGrant = NonNullable<Network["adb"]>[number];

export const roleOverridesSchema = z
  .strictObject({
    network: networkSchema
      .optional()
      .meta(d("Network grants every person with this role gets, merged with their own.")),
  })
  .meta(d("Settings for everyone who plays this role."));

/** What a person may reach after role and person grants are merged. */
export interface NetworkGrants {
  rawHttp: boolean;
  http: HttpGrant[];
  adb: AdbGrant[];
}

/**
 * The grants of a person: those of their role, then of the roles they extend, then their own. A later grant with
 * the same name replaces an earlier one; `raw_http` is the last value given.
 */
export function networkGrants(
  team: { roles?: Record<string, { network?: Network | undefined } | undefined> | undefined },
  person: { role: string; extends?: string[] | undefined; network?: Network | undefined },
): NetworkGrants {
  const layers = [person.role, ...(person.extends ?? [])].map((r) => team.roles?.[r]?.network);
  layers.push(person.network);
  const http = new Map<string, HttpGrant>();
  const adb = new Map<string, AdbGrant>();
  let rawHttp = false;
  for (const layer of layers) {
    for (const g of layer?.http ?? []) {
      http.set(g.name, g);
    }

    for (const g of layer?.adb ?? []) {
      adb.set(g.name, g);
    }

    if (layer?.raw_http !== undefined) {
      rawHttp = layer.raw_http;
    }
  }

  return { rawHttp, http: [...http.values()], adb: [...adb.values()] };
}

/** The secret keys the bearer tokens of these grants name. */
export const grantTokenKeys = (grants: NetworkGrants): string[] => [
  ...new Set(grants.http.flatMap((g) => (g.token ? [g.token] : []))),
];
