import type { Logger } from "./types.js";

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
