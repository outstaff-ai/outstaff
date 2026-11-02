/** The global options of a program that may come before its subcommand. */
interface ProgramOptions {
  /** Options that take the next word as their value. */
  valued: string[];

  /** Options that never take a value. */
  flags: string[];
}

/**
 * Global options of the infrastructure CLIs the catalog ships, as their own help lists them (`kubectl options`,
 * `helm --help`). With them a rule finds the subcommand in `kubectl -n ops get pods` without a `valued_options`
 * declaration; an option not listed here is still guessed at.
 */
const KNOWN: Record<string, ProgramOptions> = {
  kubectl: {
    valued: [
      "--as",
      "--as-group",
      "--as-uid",
      "--cache-dir",
      "--certificate-authority",
      "--client-certificate",
      "--client-key",
      "--cluster",
      "--context",
      "--kubeconfig",
      "--log-flush-frequency",
      "-n",
      "--namespace",
      "--password",
      "--profile",
      "--profile-output",
      "--request-timeout",
      "-s",
      "--server",
      "--tls-server-name",
      "--token",
      "--user",
      "--username",
      "-v",
      "--v",
      "--vmodule",
    ],
    flags: [
      "--disable-compression",
      "--insecure-skip-tls-verify",
      "--match-server-version",
      "--warnings-as-errors",
    ],
  },
  helm: {
    valued: [
      "--burst-limit",
      "--color",
      "--colour",
      "--content-cache",
      "--kube-apiserver",
      "--kube-as-group",
      "--kube-as-user",
      "--kube-ca-file",
      "--kube-context",
      "--kube-tls-server-name",
      "--kube-token",
      "--kubeconfig",
      "-n",
      "--namespace",
      "--qps",
      "--registry-config",
      "--repository-cache",
      "--repository-config",
    ],
    flags: ["--debug", "--kube-insecure-skip-tls-verify"],
  },
};

const NONE: ProgramOptions = { valued: [], flags: [] };

export const knownOptions = (program: string): ProgramOptions => KNOWN[program] ?? NONE;
