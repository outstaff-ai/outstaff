import type { ErrorCode } from "@outstaff/protocol";

/** Thrown by a source to answer a request with a specific error code. */
export class ProtocolError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}
