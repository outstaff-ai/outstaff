import { PortError, silentLogger, type DeriveContext, type TeamConfig } from "@outstaff/core";
import { connectItsaplan } from "@outstaff/integration.shared.itsaplan";
import { describe, expect, it } from "vitest";
import { itsaplanTracker, trackerOptions } from "#/index.js";
import { fieldChecks, fieldHelpers, prepareFields } from "#/fields.js";
import { createItsaplanTracker } from "#/tracker.js";
import { API_KEY, createItsaplanFake, secretMap, team } from "@outstaff/testing.itsaplan";

const TOKENS = "Agent tokens";
const COST = "Agent cost, USD (API-equivalent)";

function setup(usage?: TeamConfig["usage"]) {
  const fake = createItsaplanFake();
  const options = trackerOptions.parse({ url: "https://tracker.acme.example", project: "SHOP" });
  const withUsage = { ...team, ...(usage ? { usage } : {}) } as TeamConfig;
  const derive: DeriveContext = {
    team: withUsage,
    scope: "office",
    options,
    fetch: fake.fetch,
    now: () => new Date("2026-01-01T00:00:00Z"),
    warn: () => {},
  };

  const tracker = () =>
    createItsaplanTracker({
      options,
      secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }),
      team: withUsage,
      log: silentLogger,
      fetch: fake.fetch,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

  return { fake, derive, tracker, secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }) };
}

describe("custom number fields", () => {
  it("sets a field by its id, as the API key's member", async () => {
    const { fake, tracker } = setup();
    const t = await tracker();
    expect(await t.ensureField!({ name: TOKENS, type: "number" })).toBe("created");
    const issue = await t.createIssue({ title: "Counted", body: "" });
    await t.setField!(issue.key, TOKENS, 1500);
    const field = fake.state.customFields[0]!;
    expect(field).toMatchObject({ name: TOKENS, fieldType: "number", issueTypeId: null });
    expect(fake.state.fieldValues).toMatchObject([
      { issueId: Number(issue.id), fieldId: field.id, value: 1500, by: "u-sam" },
    ]);

    await t.setField!(issue.key, TOKENS, null);
    expect(await t.fieldValue!(issue.key, TOKENS)).toBeNull();
    expect(fake.state.fieldValues).toHaveLength(1);
  });

  it("refuses a field of the same name and another type", async () => {
    const { fake, tracker } = setup();
    fake.state.customFields.push({
      id: 9,
      issueTypeId: null,
      name: "agent tokens",
      fieldType: "text",
      memberScope: null,
      showInBody: false,
      position: 0,
      options: [],
    });

    const t = await tracker();
    await expect(t.ensureField!({ name: TOKENS, type: "number" })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("reads a value the tracker gives as text as a number", async () => {
    const { fake, tracker } = setup();
    const t = await tracker();
    await t.ensureField!({ name: TOKENS, type: "number" });
    const issue = await t.createIssue({ title: "Counted", body: "" });
    fake.state.fieldValues.push({
      issueId: Number(issue.id),
      fieldId: fake.state.customFields[0]!.id,
      value: "42",
      valueEnd: null,
      optionIds: [],
      by: "u-sam",
    });

    expect(await t.fieldValue!(issue.key, TOKENS)).toBe(42);
  });

  it("takes a field someone else created meanwhile as there, and passes other errors on", async () => {
    const { fake, derive } = setup();
    const { api } = await connectItsaplan(API_KEY, derive);
    const listed = api.http.request.bind(api.http);
    let posted = 0;
    api.http.request = (async (method: string, path: string, opts?: never) => {
      if (method === "POST") {
        posted += 1;
        throw new PortError(posted === 1 ? "conflict" : "forbidden", "no");
      }

      return listed(method, path, opts);
    }) as typeof api.http.request;

    const helpers = fieldHelpers(api, (key) => api.issue(key));
    expect(await helpers.ensureField({ name: TOKENS, type: "number" })).toBe("exists");
    await expect(helpers.ensureField({ name: TOKENS, type: "number" })).rejects.toMatchObject({
      code: "forbidden",
    });

    expect(fake.state.customFields).toEqual([]);
  });
});

describe("setting up and checking the usage fields", () => {
  it("creates both fields once, and the doctor finds them", async () => {
    const { derive, secrets } = setup();
    expect(await itsaplanTracker.prepare!(secrets, derive)).toEqual([
      `created the custom number field "${TOKENS}"`,
      `created the custom number field "${COST}"`,
    ]);

    expect(await prepareFields(secrets, derive)).toEqual([]);
    const checks = await itsaplanTracker.doctor!(secrets, derive);
    expect(checks.at(-1)).toMatchObject({ name: "Its a Plan usage fields", status: "ok" });
  });

  it("warns about a missing field, and when the fields cannot be read", async () => {
    const { derive } = setup();
    const { api } = await connectItsaplan(API_KEY, derive);
    await api.http.request("POST", `${api.projectPath}/custom-fields`, {
      body: { name: TOKENS, fieldType: "number" },
    });

    expect(await fieldChecks(api, derive)).toMatchObject([
      { status: "warn", detail: expect.stringContaining(`field "${COST}"`) },
    ]);

    const none = await connectItsaplan(API_KEY, derive);
    expect((await fieldChecks(none.api, derive))[0]?.status).toBe("warn");
    none.api.http.request = (async () => {
      throw new Error("down");
    }) as typeof api.http.request;

    expect(await fieldChecks(none.api, derive)).toMatchObject([
      { status: "warn", detail: expect.stringContaining("down") },
    ]);
  });

  it("lists both missing fields in one warning", async () => {
    const { derive } = setup();
    const { api } = await connectItsaplan(API_KEY, derive);
    expect(await fieldChecks(api, derive)).toMatchObject([
      { detail: expect.stringContaining(`fields "${TOKENS}" and "${COST}"`) },
    ]);
  });

  it("does nothing when the team does not want the fields, or without a key", async () => {
    const off = setup({ track_cost: true, tracker_fields: false });
    expect(await prepareFields(off.secrets, off.derive)).toEqual([]);
    const { api } = await connectItsaplan(API_KEY, off.derive);
    expect(await fieldChecks(api, off.derive)).toEqual([]);
    const on = setup();
    expect(await prepareFields(secretMap({}), on.derive)).toEqual([]);
  });

  it("says how to add a field it cannot create", async () => {
    const { derive, secrets, fake } = setup();
    fake.state.customFields.push({
      id: 9,
      issueTypeId: null,
      name: TOKENS,
      fieldType: "text",
      memberScope: null,
      showInBody: false,
      position: 0,
      options: [],
    });

    await expect(prepareFields(secrets, derive)).rejects.toThrow(
      /could not create the custom field "Agent tokens".*add it as a number field/,
    );
  });
});
