import { statfs } from "node:fs/promises";
import type { DoctorCheck } from "@outstaff/core";
import type { VolumeUsage } from "./types.js";

/** The share of the home volume used from which the doctor warns, and the sweep prunes the package caches. */
export const WARN_AT = 0.8;
const FAIL_AT = 0.9;
const GIB = 1024 ** 3;

/** The volume a path is on, as statfs sees it: what is used of what the filesystem holds. */
export async function volumeUsage(path: string): Promise<VolumeUsage> {
  const s = await statfs(path);
  return { used: (s.blocks - s.bfree) * s.bsize, total: s.blocks * s.bsize };
}

const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;

const statusOf = (share: number): DoctorCheck["status"] =>
  share >= FAIL_AT ? "fail" : share >= WARN_AT ? "warn" : "ok";

/** What the fix line says the space goes to, when the breakdown can be had; nothing otherwise. */
const breakdownOf = async (breakdown: (() => Promise<string | undefined>) | undefined) =>
  (await breakdown?.().catch(() => undefined)) ?? "";

/**
 * How full the agent's home volume is: a warning from 80% used, a failure from 90%. Over the warning, the fix line
 * names the largest known folders of the home, from `breakdown`, measured only then.
 */
export async function diskCheck(
  home: string,
  read: (path: string) => Promise<VolumeUsage> = volumeUsage,
  breakdown?: () => Promise<string | undefined>,
): Promise<DoctorCheck> {
  let usage: VolumeUsage;
  try {
    usage = await read(home);
  } catch (e) {
    return {
      name: "Home volume space",
      status: "warn",
      detail: `The usage of ${home} could not be read: ${(e as Error).message}`,
    };
  }

  const share = usage.total > 0 ? usage.used / usage.total : 0;
  const status = statusOf(share);
  const detail = `${home}: ${gib(usage.used)} of ${gib(usage.total)} used (${Math.round(share * 100)}%).`;
  if (status === "ok") {
    return { name: "Home volume space", status, detail };
  }

  const largest = await breakdownOf(breakdown);
  return {
    name: "Home volume space",
    status,
    detail,
    fix: `${largest ? `${largest} ` : ""}Free space or grow the volume.`,
  };
}
