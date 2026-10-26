import { PortError } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { slackErrorName, toPortError } from "../errors.js";
import { slackError } from "../testing/slack-fake.js";

describe("toPortError", () => {
  it("passes a port error through untouched", () => {
    const original = new PortError("forbidden", "no");
    expect(toPortError(original)).toBe(original);
  });

  it("maps Slack's error strings to port error codes and keeps the cause", () => {
    const cause = slackError("channel_not_found");
    const mapped = toPortError(cause);
    expect(mapped.code).toBe("not_found");
    expect(mapped.cause).toBe(cause);
    expect(toPortError(slackError("missing_scope")).code).toBe("forbidden");
    expect(toPortError(slackError("msg_too_long")).code).toBe("invalid");
    expect(toPortError(slackError("ratelimited")).code).toBe("rate_limited");
  });

  it("treats an error string it does not know, or none, as unavailable", () => {
    expect(toPortError(slackError("something_new")).code).toBe("unavailable");
    expect(toPortError(new Error("boom")).code).toBe("unavailable");
  });

  it("turns a rate limit into a retry delay in milliseconds", () => {
    const limited = Object.assign(new Error("slow down"), {
      code: "slack_webapi_rate_limited_error",
      retryAfter: 30,
    });

    expect(toPortError(limited)).toMatchObject({ code: "rate_limited", retryAfterMs: 30_000 });
  });

  it("reports a rate limit without a retry delay as having none", () => {
    const limited = Object.assign(new Error("slow down"), {
      code: "slack_webapi_rate_limited_error",
    });

    const mapped = toPortError(limited);
    expect(mapped.code).toBe("rate_limited");
    expect(mapped.retryAfterMs).toBeUndefined();
  });

  it("keeps the text of a thrown value that is not an Error", () => {
    const mapped = toPortError("socket closed");
    expect(mapped.code).toBe("unavailable");
    expect(mapped.message).toBe("socket closed");
    expect(toPortError(undefined).message).toBe("undefined");
  });
});

describe("slackErrorName", () => {
  it("reads the API's error string, when there is one", () => {
    expect(slackErrorName(slackError("already_reacted"))).toBe("already_reacted");
    expect(slackErrorName(new Error("plain"))).toBeUndefined();
    expect(slackErrorName(undefined)).toBeUndefined();
  });
});
