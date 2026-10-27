import { parseRepoUrl, type DoctorCheck } from "@outstaff/core";

export const ok = (name: string, detail: string, key?: string): DoctorCheck => ({
  ...(key ? { key } : {}),
  name,
  status: "ok",
  detail,
});

export const bad = (
  status: "warn" | "fail",
  name: string,
  detail: string,
  fix: string,
  key?: string,
): DoctorCheck => ({ ...(key ? { key } : {}), name, status, detail, fix });

export const repoName = (url: string) => {
  const r = parseRepoUrl(url);
  return `${r.owner}/${r.name}`.toLowerCase();
};
