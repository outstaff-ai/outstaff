import { afterEach, beforeEach, describe, expect } from "vitest";
import type { TestContext } from "vitest";
import type { Capability } from "#/types.js";
import { PortError, type PortErrorCode } from "#/ports/index.js";
import type { ContractSetup, ContractSetupFn } from "./types.js";

/** Fresh subject per test. `define` receives a getter for the current setup. */
export function contractSuite<Subject, Seed>(
  title: string,
  setup: ContractSetupFn<Subject, Seed>,
  define: (get: () => ContractSetup<Subject, Seed>) => void,
): void {
  describe(`${title}`, () => {
    let current: ContractSetup<Subject, Seed> | undefined;
    beforeEach(async () => {
      current = await setup();
    });

    afterEach(async () => {
      await current?.cleanup?.();
      current = undefined;
    });

    define(() => current!);
  });
}

export function requireCapability(
  t: TestContext,
  setup: ContractSetup<unknown, unknown>,
  ...caps: Capability[]
): void {
  for (const cap of caps) {
    if (!setup.capabilities.includes(cap)) {
      t.skip(`adapter does not declare ${cap}`);
    }
  }
}

/** Returns the seed function or skips the test when the adapter's seed lacks it. */
export function requireSeed<S, K extends keyof S>(
  t: TestContext,
  seed: Partial<S>,
  name: K,
): NonNullable<S[K]> {
  const fn = seed[name];
  if (fn === undefined || fn === null) {
    t.skip(`seed.${String(name)} not provided`);
  }

  return fn as NonNullable<S[K]>;
}

export async function expectPortError(
  promise: Promise<unknown>,
  code: PortErrorCode,
): Promise<PortError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );

  expect(error, `expected a PortError with code ${code}`).toBeInstanceOf(PortError);
  expect((error as PortError).code).toBe(code);
  return error as PortError;
}

export function expectAbsoluteUrl(url: string): void {
  expect(() => new URL(url), `"${url}" is not an absolute URL`).not.toThrow();
  expect(["http:", "https:"]).toContain(new URL(url).protocol);
}

/**
 * Event cursor rules shared by every port: the cursor is opaque, a replay may only repeat events
 * already returned (adapters re-read an overlap and intake de-duplicates), ids are unique per page.
 */
export async function expectEventCursorBehaviour<E extends { externalId: string; at?: string }>(
  fetch: (cursor?: string) => Promise<{ events: E[]; cursor: string }>,
  produceMore: () => Promise<void>,
): Promise<void> {
  const first = await fetch();
  expect(typeof first.cursor).toBe("string");
  expect(first.events.length).toBeGreaterThan(0);
  const again = await fetch(first.cursor);
  const seen = new Set(first.events.map((e) => e.externalId));
  expect(
    again.events.filter((e) => !seen.has(e.externalId)),
    "a replay must not return events never returned before",
  ).toEqual([]);

  await produceMore();
  const next = await fetch(first.cursor);
  const fresh = next.events.filter((e) => !seen.has(e.externalId));
  expect(fresh.length).toBeGreaterThan(0);
  for (const page of [first, again, next]) {
    const pageIds = page.events.map((e) => e.externalId);
    expect(new Set(pageIds).size, "externalId must be unique within a page").toBe(pageIds.length);
  }

  const ids = [...first.events, ...fresh].map((e) => e.externalId);
  const times = [...first.events, ...fresh]
    .map((e) => e.at)
    .filter((a): a is string => a !== undefined);

  expect(times, "events must come in chronological order").toEqual([...times].toSorted());
  const fromStart = await fetch();
  expect(fromStart.events.map((e) => e.externalId)).toEqual(ids);
}
