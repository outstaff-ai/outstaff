import { statSync } from "node:fs";
import { join } from "node:path";
import type { DoctorCheck, SecretSource } from "@outstaff/core";
import type { sections } from "../setup-template.js";
import { fail, plural } from "./check.js";

/** A key whose file may stand in for it; the spec for the alternative itself is then not required. */
const FILE_ALTERNATIVE = /_PRIVATE_KEY$/;

function modeOf(path: string): number | undefined {
  try {
    const st = statSync(path);
    return st.isFile() ? st.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}

type Spec = ReturnType<typeof sections>[number]["specs"][number];

/** Is the key set, or for a private key, its file? */
function isPresent(key: string, secrets: SecretSource): boolean {
  const alt = FILE_ALTERNATIVE.test(key) ? `${key}_FILE` : undefined;
  return secrets.get(key) !== undefined || (alt !== undefined && secrets.get(alt) !== undefined);
}

const missingFix = (spec: Spec, dir: string, handle: string) =>
  spec.derivable
    ? `Run \`ost setup ${handle} --derive\`, or create ${join(dir, spec.key)}.`
    : `Create ${join(dir, spec.key)} (${spec.where}).`;

/** Whether a required key is provided; optional keys and private key file paths are not reported. */
function presenceCheck(
  spec: Spec,
  secrets: SecretSource,
  dir: string,
  handle: string,
): DoctorCheck[] {
  if (spec.optional || spec.key.endsWith("_PRIVATE_KEY_FILE")) {
    return [];
  }

  if (isPresent(spec.key, secrets)) {
    return [{ key: spec.key, name: `${spec.key} present`, status: "ok", detail: "Provided." }];
  }

  const detail = `${spec.key} is not set as a file in ${dir} or in the environment.`;
  return [fail(`${spec.key} present`, detail, missingFix(spec, dir, handle), spec.key)];
}

const octal = (mode: number) => mode.toString(8).padStart(4, "0");

/** A finding when the secret file is readable by others or not exactly 0600; nothing when it is fine or absent. */
function modeCheck(spec: Spec, dir: string): DoctorCheck[] {
  const file = join(dir, spec.key);
  const mode = modeOf(file);
  if (mode === undefined || process.platform === "win32") {
    return [];
  }

  if ((mode & 0o077) !== 0) {
    const detail = `${file} has mode ${octal(mode)}; other users can read it.`;
    return [fail(`${spec.key} file mode`, detail, `chmod 600 ${file}`, spec.key)];
  }

  if (mode === 0o600) {
    return [];
  }

  return [
    {
      key: spec.key,
      name: `${spec.key} file mode`,
      status: "warn",
      detail: `${file} has mode ${octal(mode)}, not 0600.`,
      fix: `chmod 600 ${file}`,
    },
  ];
}

/** One ok line for the secret files when none of them has a mode problem. */
function modesSummary(specs: Spec[], dir: string): DoctorCheck[] {
  const files = specs.filter((s) => modeOf(join(dir, s.key)) !== undefined).length;
  if (files === 0) {
    return [];
  }

  const detail = `${plural(files, "secret file")} in ${dir}, all 0600.`;
  return [{ name: "Secret file modes", status: "ok", detail }];
}

/** Presence of every required key and the mode of every secret file. */
export function secretChecks(
  list: ReturnType<typeof sections>,
  secrets: SecretSource,
  dir: string,
  handle: string,
): DoctorCheck[] {
  const specs = list.flatMap((s) => s.specs);
  const presence = specs.flatMap((spec) => presenceCheck(spec, secrets, dir, handle));
  const modes = specs.flatMap((spec) => modeCheck(spec, dir));
  return [...presence, ...modes, ...(modes.length === 0 ? modesSummary(specs, dir) : [])];
}
