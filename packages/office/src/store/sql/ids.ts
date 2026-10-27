import { randomBytes } from "node:crypto";

let lastMs = 0;
let counter = 0;

/** Time-ordered unique id: sorts by creation order within a process. */
export function newId(ms: number): string {
  if (ms === lastMs) {
    counter++;
  } else {
    lastMs = ms;
    counter = 0;
  }

  return `${ms.toString().padStart(13, "0")}${counter.toString().padStart(4, "0")}${randomBytes(4).toString("hex")}`;
}

export const iso = (d: Date) => d.toISOString();
