import type { RoleInfo } from "./messaging/index.js";
import type { CreateOfficeInput, OfficeOptions } from "./office.types.js";
import { defined } from "./defined.js";

export function webhookOptions(o: OfficeOptions) {
  return { webhook: { port: o.webhookPort ?? 8082, ...defined({ host: o.webhookHost }) } };
}

export function roleInfo(catalog: CreateOfficeInput["catalog"]): Map<string, RoleInfo> {
  const roles = new Map<string, RoleInfo>();
  for (const [key, role] of Object.entries(catalog?.roles ?? {})) {
    roles.set(key, { title: role.title, summary: role.summary });
  }

  return roles;
}
