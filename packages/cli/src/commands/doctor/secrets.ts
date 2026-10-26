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

/** Presence of every required key and the mode of every secret file. */
export function secretChecks(
  list: ReturnType<typeof sections>,
  secrets: SecretSource,
  dir: string,
  handle: string,
): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const specs = list.flatMap((s) => s.specs);
  for (const spec of specs) {
    if (spec.key.endsWith("_PRIVATE_KEY_FILE")) {
      continue;
    }

    const alt = FILE_ALTERNATIVE.test(spec.key) ? `${spec.key}_FILE` : undefined;
    const present = secrets.get(spec.key) !== undefined || (alt && secrets.get(alt) !== undefined);
    if (present) {
      if (!spec.optional) {
        out.push({
          key: spec.key,
          name: `${spec.key} present`,
          status: "ok",
          detail: "Provided.",
        });
      }
    } else if (!spec.optional) {
      out.push(
        fail(
          `${spec.key} present`,
          `${spec.key} is not set as a file in ${dir} or in the environment.`,
          spec.derivable
            ? `Run \`ost setup ${handle} --derive\`, or create ${join(dir, spec.key)}.`
            : `Create ${join(dir, spec.key)} (${spec.where}).`,
          spec.key,
        ),
      );
    }
  }

  for (const spec of specs) {
    const file = join(dir, spec.key);
    const mode = modeOf(file);
    if (mode === undefined || process.platform === "win32") {
      continue;
    }

    if ((mode & 0o077) !== 0) {
      out.push(
        fail(
          `${spec.key} file mode`,
          `${file} has mode ${mode.toString(8).padStart(4, "0")}; other users can read it.`,
          `chmod 600 ${file}`,
          spec.key,
        ),
      );
    } else if (mode !== 0o600) {
      out.push({
        key: spec.key,
        name: `${spec.key} file mode`,
        status: "warn",
        detail: `${file} has mode ${mode.toString(8).padStart(4, "0")}, not 0600.`,
        fix: `chmod 600 ${file}`,
      });
    }
  }

  if (!out.some((c) => c.name.endsWith("file mode"))) {
    const files = specs.filter((s) => modeOf(join(dir, s.key)) !== undefined).length;
    if (files > 0) {
      out.push({
        name: "Secret file modes",
        status: "ok",
        detail: `${plural(files, "secret file")} in ${dir}, all 0600.`,
      });
    }
  }

  return out;
}
