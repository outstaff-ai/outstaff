import type { TeamConfig } from "@outstaff/core";
import type { Grants } from "./types.js";

const KIND_KEY = /^kind:(primary|baseline|infra|other)$/;

/** Write access where the role does its work, read everywhere else. */
export function defaultGrants(config: TeamConfig, permissions: string): Grants {
  const kind = permissions === "code" ? "primary" : permissions === "infra" ? "infra" : undefined;
  const grants: Grants = {};
  for (const r of config.repos) {
    if (kind && r.kind === kind) {
      grants[r.name] = "write";
    }
  }

  grants["*"] = "read";
  return grants;
}

export function formatGrants(grants: Grants): string {
  return Object.entries(grants)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

type Access = Grants[string];

const isAccess = (v: string | undefined): v is Access => v === "read" || v === "write";

/** One `repo=read|write` entry as key and access; undefined when it is not of that form. */
function parseEntry(part: string): [string, Access] | undefined {
  const [key, access, ...rest] = part.split("=").map((s) => s.trim());
  if (!key || rest.length > 0 || !isAccess(access)) {
    return undefined;
  }

  return [key, access];
}

/** Whether a grant key names a repo of the team, a repo kind, or every repo. */
const isGrantKey = (key: string, config: TeamConfig): boolean =>
  key === "*" || KIND_KEY.test(key) || config.repos.some((r) => r.name === key);

/** `shop=write,*=read` to grants, or the reason it is not valid. */
export function parseGrants(text: string, config: TeamConfig): Grants | string {
  const grants: Grants = {};
  const parts = text
    .split(",")
    .map((s) => s.trim())
    .filter((part) => part !== "");

  for (const part of parts) {
    const entry = parseEntry(part);
    if (!entry) {
      return `"${part}" is not repo=read or repo=write.`;
    }

    const [key, access] = entry;
    if (!isGrantKey(key, config)) {
      return `"${key}" is not a repo of this team (repos: ${config.repos.map((r) => r.name).join(", ")}), "kind:<kind>" or "*".`;
    }

    grants[key] = access;
  }

  return Object.keys(grants).length > 0 ? grants : "Give at least one grant, for example *=read.";
}
