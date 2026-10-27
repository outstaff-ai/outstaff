import { PortError } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { GithubHttp, nextLink } from "../http.js";
import { expectPortError } from "../testing/harness.js";

const API = "https://api.github.test";

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

/** A GithubHttp over a scripted fetch: each call takes the next reply (or throws it, when it is an Error). */
function client(replies: (Response | Error)[], apiUrl = API) {
  const seen: Seen[] = [];
  const fetchStub = (async (input: string, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    const reply = replies.shift();
    if (reply === undefined) {
      throw new Error("unscripted request");
    }

    if (reply instanceof Error) {
      throw reply;
    }

    return reply;
  }) as typeof fetch;

  const http = new GithubHttp({
    fetch: fetchStub,
    apiUrl,
    graphqlUrl: `${apiUrl}/graphql`,
    now: () => new Date("2026-01-01T00:00:00Z"),
  });

  return { http, seen };
}

const redirect = (location?: string) =>
  new Response(null, { status: 302, headers: location === undefined ? {} : { location } });

describe("GithubHttp.getRedirected", () => {
  it("fetches the redirect target without the token", async () => {
    const { http, seen } = client([
      redirect("https://logs.test/a?sig=1"),
      new Response("log text"),
    ]);

    await expect(http.getRedirected("/logs", "tok")).resolves.toBe("log text");
    expect(new Headers(seen[0]!.init?.headers).get("authorization")).toBe("Bearer tok");
    expect(seen[1]!.url).toBe("https://logs.test/a?sig=1");
    expect(new Headers(seen[1]!.init?.headers).get("authorization")).toBeNull();
  });

  it("returns the body of a direct answer", async () => {
    const { http } = client([new Response("direct log")]);
    await expect(http.getRedirected("/logs", "tok")).resolves.toBe("direct log");
  });

  it("maps an unreachable GitHub to unavailable", async () => {
    const { http } = client([new Error("offline")]);
    const e = await expectPortError(http.getRedirected("/logs", "tok"), "unavailable");
    expect(e.message).toContain("offline");
  });

  it("refuses a redirect to a plain http URL on another host", async () => {
    const { http, seen } = client([redirect("http://logs.test/a")]);
    const e = await expectPortError(http.getRedirected("/logs", "tok"), "unavailable");
    expect(e.message).toContain("not https");
    expect(seen).toHaveLength(1);
  });

  it("allows a redirect to plain http on the API host itself", async () => {
    const local = "http://localhost:9999";
    const { http, seen } = client([redirect("/blob"), new Response("local log")], local);
    await expect(http.getRedirected("/logs", "tok")).resolves.toBe("local log");
    expect(seen[1]!.url).toBe(`${local}/blob`);
  });

  it("refuses a redirect whose location is not a URL", async () => {
    const { http } = client([redirect("http://")]);
    const e = await expectPortError(http.getRedirected("/logs", "tok"), "unavailable");
    expect(e.message).toContain("usable location");
  });

  it("refuses a redirect without a location and fetches nothing more", async () => {
    const { http, seen } = client([redirect(), new Response("denied", { status: 401 })]);
    const e = await expectPortError(http.getRedirected("/logs", "tok"), "unavailable");
    expect(e.message).toContain("usable location");
    expect(seen).toHaveLength(1);
  });

  it("maps an unreachable log host to unavailable", async () => {
    const { http } = client([redirect("https://logs.test/a"), new Error("dns")]);
    const e = await expectPortError(http.getRedirected("/logs", "tok"), "unavailable");
    expect(e.message).toContain("log host is unreachable");
    expect(e.cause).toBeInstanceOf(Error);
  });

  it("maps a failing log host to unavailable with its status", async () => {
    const { http } = client([redirect("https://logs.test/a"), new Response("", { status: 503 })]);
    const e = await expectPortError(http.getRedirected("/logs", "tok"), "unavailable");
    expect(e.message).toContain("503");
  });

  it("maps a JSON error from GitHub", async () => {
    const { http } = client([new Response(JSON.stringify({ message: "gone" }), { status: 404 })]);
    const e = await expectPortError(http.getRedirected("/logs", "tok"), "not_found");
    expect(e.message).toContain("gone");
  });

  it("maps an error with an empty or non-JSON body from its status", async () => {
    const empty = client([new Response("", { status: 409, statusText: "Conflict" })]);
    const e = await expectPortError(empty.http.getRedirected("/logs", "tok"), "conflict");
    expect(e.message).toContain("Conflict");

    const html = client([new Response("<html>bad gateway</html>", { status: 502 })]);
    const f = await expectPortError(html.http.getRedirected("/logs", "tok"), "unavailable");
    expect(f.message).toContain("<html>bad gateway</html>");
  });
});

describe("GithubHttp.request", () => {
  it("skips undefined query values and sends the JSON body", async () => {
    const { http, seen } = client([new Response("{}")]);
    await http.request("POST", "/x", {
      token: "t",
      query: { a: 1, b: undefined, c: "z" },
      body: { k: 1 },
    });

    expect(seen[0]!.url).toBe(`${API}/x?a=1&c=z`);
    expect(seen[0]!.init?.body).toBe('{"k":1}');
  });

  it("resolves an empty success body to undefined data", async () => {
    const { http } = client([new Response(null, { status: 204 })]);
    const res = await http.request("DELETE", "/x", { token: "t" });
    expect(res).toMatchObject({ status: 204, data: undefined, text: "" });
  });

  it("resolves a non-JSON success body to undefined data, keeping the text", async () => {
    const { http } = client([new Response("diff --git")]);
    const res = await http.request("GET", "/x", { token: "t" });
    expect(res.data).toBeUndefined();
    expect(res.text).toBe("diff --git");
  });

  it("resolves a 304 without data", async () => {
    const { http } = client([new Response(null, { status: 304 })]);
    await expect(http.request("GET", "/x", { token: "t" })).resolves.toMatchObject({
      status: 304,
      data: undefined,
    });
  });

  it("falls back to the status text when the error has no body", async () => {
    const { http } = client([new Response("", { status: 500, statusText: "Boom" })]);
    const e = await expectPortError(http.request("GET", "/x", { token: "t" }), "unavailable");
    expect(e.message).toContain("500 Boom");
  });

  it("maps an unreachable GitHub to unavailable", async () => {
    expect.hasAssertions();
    const { http } = client([new Error("offline")]);
    await expectPortError(http.request("GET", "/x", { token: "t" }), "unavailable");
  });

  it.each([
    [429, {}, "rate_limited"],
    [403, { "retry-after": "3" }, "rate_limited"],
    [403, { "x-ratelimit-remaining": "0" }, "rate_limited"],
    [403, {}, "forbidden"],
    [401, {}, "forbidden"],
    [404, {}, "not_found"],
    [409, {}, "conflict"],
    [422, {}, "invalid"],
    [400, {}, "invalid"],
    [502, {}, "unavailable"],
    [418, {}, "invalid"],
  ] as const)("maps %s %j to %s", async (status, headers, code) => {
    expect.hasAssertions();
    const { http } = client([new Response("{}", { status, headers })]);
    await expectPortError(http.request("GET", "/x", { token: "t" }), code);
  });

  it("reads the wait from retry-after, then from the reset time, else a minute", async () => {
    const wait = async (headers: Record<string, string>) => {
      const { http } = client([new Response("{}", { status: 429, headers })]);
      const e = await http.request("GET", "/x", { token: "t" }).catch((x: unknown) => x);
      return (e as PortError).retryAfterMs;
    };

    expect(await wait({ "retry-after": "7" })).toBe(7000);
    const reset = Date.parse("2026-01-01T00:00:30Z") / 1000;
    expect(await wait({ "x-ratelimit-reset": String(reset) })).toBe(30_000);
    expect(await wait({ "x-ratelimit-reset": "1" })).toBe(0);
    expect(await wait({ "retry-after": "soon" })).toBe(60_000);
    expect(await wait({})).toBe(60_000);
  });
});

describe("GithubHttp.graphql", () => {
  const answer = (body: unknown) => new Response(JSON.stringify(body));

  it("returns the data", async () => {
    const { http } = client([answer({ data: { ok: true } })]);
    await expect(http.graphql("t", "query", {})).resolves.toEqual({ ok: true });
  });

  it("fails as unavailable when there is neither data nor errors", async () => {
    expect.hasAssertions();
    const { http } = client([answer({})]);
    await expectPortError(http.graphql("t", "query", {}), "unavailable");
  });

  it.each([
    ["NOT_FOUND", "not_found"],
    ["FORBIDDEN", "forbidden"],
    ["INSUFFICIENT_SCOPES", "forbidden"],
    ["RATE_LIMITED", "rate_limited"],
    ["OTHER", "invalid"],
  ] as const)("maps a %s error to %s", async (type, code) => {
    const { http } = client([answer({ errors: [{ type, message: "nope" }] })]);
    const e = await expectPortError(http.graphql("t", "query", {}), code);
    expect(e.message).toContain("nope");
    expect(e.retryAfterMs).toBe(code === "rate_limited" ? 60_000 : undefined);
  });
});

describe("GithubHttp.paginate", () => {
  it("follows next links on the API host and stops without one", async () => {
    const link = `<${API}/items?page=2>; rel="next"`;
    const { http, seen } = client([
      new Response("[1]", { headers: { link } }),
      new Response("[2]"),
    ]);

    await expect(
      http.paginate<number[], number>("/items", { token: "t" }, (d) => d),
    ).resolves.toEqual([1, 2]);

    expect(seen.map((s) => s.url)).toEqual([`${API}/items`, `${API}/items?page=2`]);
  });

  it("stops at maxPages", async () => {
    const link = `<${API}/items?page=2>; rel="next"`;
    const { http, seen } = client([new Response("[1]", { headers: { link } })]);
    await expect(
      http.paginate<number[], number>("/items", { token: "t" }, (d) => d, 1),
    ).resolves.toEqual([1]);

    expect(seen).toHaveLength(1);
  });
});

describe("nextLink", () => {
  it("is undefined without a header", () => {
    expect(nextLink(null, API)).toBeUndefined();
  });

  it("ignores a next link to another host and non-next links", () => {
    expect(nextLink('<https://evil.test/x>; rel="next"', API)).toBeUndefined();
    expect(nextLink(`<${API}/x>; rel="prev"`, API)).toBeUndefined();
  });

  it("picks the next link among several", () => {
    expect(nextLink(`<${API}/a>; rel="prev", <${API}/b>; rel="next"`, API)).toBe(`${API}/b`);
  });
});
