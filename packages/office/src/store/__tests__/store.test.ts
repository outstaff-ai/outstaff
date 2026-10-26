import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { storeContract } from "../contract.js";
import { openStore } from "../open.js";

storeContract("sqlite in-memory", () =>
  // A :memory: database lives and dies with its connection, so losing it is closing it.
  ({
    persistent: false,
    open: (opts) => openStore("sqlite::memory:", opts),
    lose: async () => {},
    cleanup: async () => {},
  }),
);

storeContract("sqlite file", () => {
  const dir = mkdtempSync(join(tmpdir(), "outstaff-store-"));
  const url = `sqlite://${join(dir, "office.db")}`;
  return {
    persistent: true,
    open: (opts) => openStore(url, opts),
    lose: async () => {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(join(dir, `office.db${suffix}`), { force: true });
      }
    },
    cleanup: async () => rmSync(dir, { recursive: true, force: true }),
  };
});

const pgUrl = process.env["OUTSTAFF_TEST_POSTGRES_URL"] ?? "";
describe.skipIf(!pgUrl)("postgres (set OUTSTAFF_TEST_POSTGRES_URL to run)", () => {
  storeContract("postgres", () => {
    const schema = `t_${randomUUID().replaceAll("-", "")}`;
    return {
      persistent: true,
      open: (opts) => openStore(pgUrl, { ...opts, schema }),
      lose: () => dropSchema(pgUrl, schema),
      cleanup: () => dropSchema(pgUrl, schema),
    };
  });
});

async function dropSchema(url: string, schema: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`drop schema if exists "${schema}" cascade`);
  } finally {
    await client.end();
  }
}

describe("openStore", () => {
  it("rejects unsupported urls", async () => {
    await expect(openStore("mysql://x")).rejects.toThrow(/unsupported/);
  });

  it("can skip migrations", async () => {
    const store = await openStore("sqlite::memory:", { migrate: false });
    await expect(store.getCursor("a", "b")).rejects.toThrow(/./);
    await store.close();
  });
});
