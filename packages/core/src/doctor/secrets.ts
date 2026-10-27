import { statSync } from "node:fs";
import { join } from "node:path";
import type { DoctorCheck } from "#/ports/adapter.js";
import type { SecretSource, SecretSpec } from "#/ports/types.js";
import { fail, plural } from "./check.js";
import type { SecretSection } from "./types.js";

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

const octal = (mode: number) => mode.toString(8).padStart(4, "0");

function presence(spec: SecretSpec, secrets: SecretSource, dir: string, handle: string) {
  if (spec.optional || spec.key.endsWith("_PRIVATE_KEY_FILE")) {
    return [];
  }

  const alt = FILE_ALTERNATIVE.test(spec.key) ? `${spec.key}_FILE` : undefined;
  if (secrets.get(spec.key) !== undefined || (alt && secrets.get(alt) !== undefined)) {
    return [
      { key: spec.key, name: `${spec.key} present`, status: "ok" as const, detail: "Provided." },
    ];
  }

  return [
    fail(
      `${spec.key} present`,
      `${spec.key} is not set as a file in ${dir} or in the environment.`,
      spec.derivable
        ? `Run \`ost setup ${handle} --derive\`, or create ${join(dir, spec.key)}.`
        : `Create ${join(dir, spec.key)} (${spec.where}).`,
      spec.key,
    ),
  ];
}

function fileMode(spec: SecretSpec, dir: string): DoctorCheck[] {
  const file = join(dir, spec.key);
  const mode = modeOf(file);
  if (mode === undefined || process.platform === "win32" || mode === 0o600) {
    return [];
  }

  if ((mode & 0o077) !== 0) {
    return [
      fail(
        `${spec.key} file mode`,
        `${file} has mode ${octal(mode)}; other users can read it.`,
        `chmod 600 ${file}`,
        spec.key,
      ),
    ];
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

/** Presence of every required key and, unless `checkModes` is false, the mode of every secret file. */
export function secretChecks(
  list: SecretSection[],
  secrets: SecretSource,
  dir: string,
  handle: string,
  checkModes = true,
): DoctorCheck[] {
  const specs = list.flatMap((s) => s.specs);
  const present = specs.flatMap((spec) => presence(spec, secrets, dir, handle));
  if (!checkModes) {
    return present;
  }

  const modes = specs.flatMap((spec) => fileMode(spec, dir));
  const files = specs.filter((s) => modeOf(join(dir, s.key)) !== undefined).length;
  if (modes.length > 0 || files === 0) {
    return [...present, ...modes];
  }

  return [
    ...present,
    {
      name: "Secret file modes",
      status: "ok",
      detail: `${plural(files, "secret file")} in ${dir}, all 0600.`,
    },
  ];
}
