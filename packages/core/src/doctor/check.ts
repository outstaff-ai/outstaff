import type { DoctorCheck } from "#/ports/adapter.js";

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const fail = (name: string, detail: string, fix: string, key?: string): DoctorCheck => ({
  ...(key ? { key } : {}),
  name,
  status: "fail",
  detail,
  fix,
});
