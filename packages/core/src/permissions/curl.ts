import { originOf } from "../config/network.js";

/** Why a `curl` call is not allowed, or undefined when every part of it is understood and within the granted origins. */
export function curlProblem(args: string[], origins: readonly string[]): string | undefined {
  const urls: string[] = [];
  const plain = new Set([
    "-s",
    "--silent",
    "-S",
    "--show-error",
    "-i",
    "--include",
    "-I",
    "--head",
  ]);

  const cluster = /^-[sSiI]+$/;
  const valued = new Set(["-X", "--request", "-H", "--header", "-m", "--max-time"]);
  const body = new Set(["-d", "--data", "--data-raw", "--json"]);
  const forbiddenHeader = /^\s*(authorization|proxy-authorization|host|cookie)\s*:/i;
  let optionsEnded = false;

  const checkValue = (flag: string, value: string | undefined): string | undefined => {
    if (value === undefined) {
      return `curl ${flag} needs a value.`;
    }

    if (flag === "-H" || flag === "--header") {
      return forbiddenHeader.test(value)
        ? "curl may not set the Authorization, Host or Cookie header."
        : undefined;
    }

    if (body.has(flag) && value.startsWith("@")) {
      return `curl ${flag} @file would send a file; give the body inline.`;
    }

    if ((flag === "-m" || flag === "--max-time") && !/^\d+(\.\d+)?$/.test(value)) {
      return "curl --max-time takes a number of seconds.";
    }

    return undefined;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!optionsEnded && a === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && a.startsWith("-")) {
      const eq = a.startsWith("--") ? a.indexOf("=") : -1;
      const flag = eq > 0 ? a.slice(0, eq) : a;
      if (plain.has(a) || cluster.test(a)) {
        continue;
      }

      if (valued.has(flag) || body.has(flag)) {
        const inline = eq > 0 ? a.slice(eq + 1) : undefined;
        const value = inline ?? args[++i];
        const problem = checkValue(flag, value);
        if (problem) {
          return problem;
        }

        continue;
      }

      return `curl ${a.split("=")[0]} is not allowed; only simple requests to a granted service are.`;
    } else {
      urls.push(a);
    }
  }

  if (urls.length !== 1) {
    return urls.length === 0 ? "curl needs a URL." : "curl may name only one URL.";
  }

  const url = urls[0]!;
  const authority = /^https?:\/\/([^/?#]+)/i.exec(url)?.[1];
  if (/[\\\s{}[\]]/.test(url) || authority === undefined || authority.includes("@")) {
    return `curl URL ${url} is ambiguous; write it as http(s)://host[:port]/path with no userinfo.`;
  }

  const origin = originOf(url);
  if (origin === undefined || !origins.includes(origin)) {
    return `curl to ${origin ?? url} is not a granted origin; use \`ost http\` for the granted services.`;
  }

  return undefined;
}
