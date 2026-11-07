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

/**
 * A request the office may or may not have handled: the connection dropped while it waited, or no answer came in time.
 * Messages that are safe to repeat are sent once more; the rest are left to the caller.
 */
export class Unanswered extends PortError {
  constructor(message: string) {
    super("unavailable", message);
    this.name = "Unanswered";
  }
}
