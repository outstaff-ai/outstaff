/**
 * The version a running Outstaff process reports (`--version`, the agent's hello, the office's link): the image's
 * release version from `OUTSTAFF_VERSION`, which the image build sets, else its package's version. A release tag
 * builds the images without bumping package.json, so only the variable knows the release. Empty counts as unset: an
 * image built without the build argument has it empty.
 */
export function runningVersion(
  env: Readonly<Record<string, string | undefined>>,
  packageVersion: string,
): string {
  return env["OUTSTAFF_VERSION"] || packageVersion;
}
