export const name = "@outstaff/office";
export * from "./store/index.js";
export * from "./clock.js";
export * from "./intake/index.js";
export * from "./scheduler/index.js";
export * from "./protocol/index.js";
export * from "./workstate/index.js";

export * from "./messaging/index.js";
export * from "./usage/index.js";
export * from "./chat/index.js";

export * from "./pipeline/index.js";
export { createOfficeDoctor } from "./doctor/index.js";
export type { OfficeDoctor, OfficeDoctorOptions } from "./doctor/index.js";

export * from "./office.js";
export * from "./work-source.js";
export * from "./health.js";
export * from "./item-refs.js";
export * from "./item-summary.js";
export type * from "./office.types.js";
export type * from "./work-source.types.js";
export type { Cancel, Clock, HealthServer, ManualClock } from "./types.js";
