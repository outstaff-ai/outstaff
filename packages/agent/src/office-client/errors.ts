import { PortError, type PortErrorCode } from "@outstaff/core";
import type { ErrorCode } from "@outstaff/protocol";

export const FATAL: ErrorCode[] = ["auth_failed", "version_mismatch", "replaced"];

export const PORT_CODE: Partial<Record<ErrorCode, PortErrorCode>> = {
  unknown_item: "not_found",
  not_found: "not_found",
  invalid: "invalid",
  invalid_message: "invalid",
  unsupported: "unsupported",
  auth_failed: "forbidden",
};

export const unavailable = (message: string) => new PortError("unavailable", message);
