#!/usr/bin/env node
import { nodeContext, run } from "./program.js";

process.exitCode = await run(process.argv.slice(2), nodeContext());
