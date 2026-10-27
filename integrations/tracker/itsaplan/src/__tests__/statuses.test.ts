import type { TeamConfig } from "@outstaff/core";
import type { ApiProject } from "@outstaff/integration.shared.itsaplan";
import { describe, expect, it } from "vitest";
import { teamStatuses } from "#/statuses.js";

const project = (over: Partial<ApiProject> = {}): ApiProject => ({
  project: { id: 1, key: "SHOP", ref: "acme.SHOP", name: "Shop", teamRef: "acme" },
  columns: [],
  labels: [],
  assignees: [],
  ...over,
});

describe("columns", () => {
  const client = (team?: unknown) => teamStatuses(team as TeamConfig);

  it("falls back to the first column of the kind by position, counting a missing position as 0", () => {
    const columns = [
      { id: 1, name: "Later", stateType: "started" },
      { id: 2, name: "Second", stateType: "started", position: 2 },
      { id: 3, name: "Unplaced", stateType: "started" },
      { id: 4, name: "First", stateType: "started", position: -1 },
    ];

    expect(client().column(project({ columns }), "active").name).toBe("First");
  });

  it("uses the default name of a status the team file maps to nothing", () => {
    const api = client({ workflow: { statuses: { active: undefined } } });
    const columns = [{ id: 1, name: "ACTIVE", stateType: "backlog" }];
    expect(api.column(project({ columns }), "active").id).toBe(1);
  });

  it("names a column id the project does not have by the id, without a status", () => {
    expect(client().status(project(), 99)).toEqual({ name: "99" });
  });

  it("gives a column of an unknown kind and name no canonical status", () => {
    const columns = [{ id: 5, name: "Parking lot", stateType: "paused" }];
    expect(client().status(project({ columns }), 5)).toEqual({ name: "Parking lot" });
  });

  it("reads a configured status name before the column kind", () => {
    const api = client({ workflow: { statuses: { review: "QA" } } });
    const columns = [{ id: 6, name: "qa", stateType: "started" }];
    expect(api.status(project({ columns }), 6)).toEqual({ name: "qa", canonical: "review" });
  });
});
