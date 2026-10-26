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

/** `shop=write,*=read` to grants, or the reason it is not valid. */
export function parseGrants(text: string, config: TeamConfig): Grants | string {
  const grants: Grants = {};
  for (const part of text.split(",").map((s) => s.trim())) {
    if (part === "") {
      continue;
    }

    const [key, access, ...rest] = part.split("=").map((s) => s.trim());
    if (!key || rest.length > 0 || (access !== "read" && access !== "write")) {
      return `"${part}" is not repo=read or repo=write.`;
    }

    if (key !== "*" && !KIND_KEY.test(key) && !config.repos.some((r) => r.name === key)) {
      return `"${key}" is not a repo of this team (repos: ${config.repos.map((r) => r.name).join(", ")}), "kind:<kind>" or "*".`;
    }

    grants[key] = access;
  }

  return Object.keys(grants).length > 0 ? grants : "Give at least one grant, for example *=read.";
}
