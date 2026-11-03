import type { StandInRequest } from "@outstaff/testing.http";
import { issueById } from "./model.js";
import { err } from "./store.js";
import type { ActorRoute, ItsaplanStore, StoredCustomField } from "./types.js";

const FIELD_TYPES = new Set([
  "text",
  "markdown",
  "url",
  "number",
  "boolean",
  "date",
  "datetime",
  "datetime_range",
  "select",
  "multi_select",
  "member",
]);

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Creates a project field; a name the project has already is a 409, as Its a Plan answers. */
function createField(s: ItsaplanStore, r: StandInRequest) {
  const name = typeof r.json.name === "string" ? r.json.name.trim() : "";
  const fieldType = String(r.json.fieldType);
  if (!name || !FIELD_TYPES.has(fieldType)) {
    return err(400, "invalid custom field");
  }

  if (s.customFields.some((f) => sameName(f.name, name))) {
    return err(409, "a custom field with this name already exists");
  }

  const field: StoredCustomField = {
    id: ++s.counters.field,
    issueTypeId: null,
    name,
    fieldType,
    memberScope: null,
    showInBody: false,
    position: s.customFields.length,
    options: [],
  };

  s.customFields.push(field);
  return { status: 201, body: field };
}

/** Whether a value fits the field: a number field takes a number or null. */
const fits = (field: StoredCustomField, value: unknown) =>
  field.fieldType !== "number" || value === null || typeof value === "number";

/** Sets a field's value on an issue, recording who set it; a number field takes a number or null. */
function setValue(s: ItsaplanStore, r: StandInRequest, actor: string) {
  const issue = issueById(s, r.params["id"]!);
  const field = s.customFields.find((f) => f.id === Number(r.params["fieldId"]));
  if (!issue || !field) {
    return err(404, issue ? "custom field not found" : "issue not found");
  }

  const value = (r.json.value ?? null) as string | number | boolean | null;
  if (!fits(field, value)) {
    return err(400, "a number field takes a number");
  }

  const kept = s.fieldValues.filter((v) => v.issueId !== issue.id || v.fieldId !== field.id);
  const row = { issueId: issue.id, fieldId: field.id, value, valueEnd: null, optionIds: [] };
  s.fieldValues.splice(0, s.fieldValues.length, ...kept, { ...row, by: actor });
  return { ok: true };
}

/** The project's custom fields, and setting their values on issues. */
export function fieldRoutes(s: ItsaplanStore): ActorRoute[] {
  const isProject = (p: string) => p === s.key || p === s.ref;
  return [
    {
      method: "GET",
      path: "/projects/:p/custom-fields",
      handler: (r) => (isProject(r.params["p"]!) ? s.customFields : err(404, "project not found")),
    },
    {
      method: "POST",
      path: "/projects/:p/custom-fields",
      handler: (r) =>
        isProject(r.params["p"]!) ? createField(s, r) : err(404, "project not found"),
    },
    {
      method: "PUT",
      path: "/issues/:id/fields/:fieldId",
      handler: (r, actor) => setValue(s, r, actor),
    },
  ];
}
