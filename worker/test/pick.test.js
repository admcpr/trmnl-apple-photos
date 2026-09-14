import test from "node:test";
import assert from "node:assert/strict";
import { dayNumber, fnv1a, isValidDay, localDay, offsetDay, pickIndex, resolveDay, seededOrder } from "../src/pick.js";

test("fnv1a is stable", () => {
  assert.equal(fnv1a("hello"), fnv1a("hello"));
  assert.notEqual(fnv1a("hello"), fnv1a("hellp"));
});

test("seededOrder is a permutation and deterministic", () => {
  const a = seededOrder(25, 42);
  const b = seededOrder(25, 42);
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort((x, y) => x - y), Array.from({ length: 25 }, (_, i) => i));
  assert.notDeepEqual(seededOrder(25, 43), a);
});

test("dayNumber and isValidDay", () => {
  assert.equal(dayNumber("1970-01-01"), 0);
  assert.equal(dayNumber("1970-01-02"), 1);
  assert.ok(isValidDay("2026-02-28"));
  assert.ok(!isValidDay("2026-02-30"));
  assert.ok(!isValidDay("2026-2-3"));
  assert.ok(!isValidDay("tomorrow"));
});

test("pickIndex shows every photo once per cycle", () => {
  const count = 7;
  const start = dayNumber("2026-09-14");
  // Align to the start of a cycle, then walk one full cycle.
  const cycleStart = Math.floor(start / count) * count;
  const seen = new Set();
  for (let n = cycleStart; n < cycleStart + count; n++) {
    const day = new Date(n * 86400000).toISOString().slice(0, 10);
    seen.add(pickIndex({ count, day, key: "cloudkit:abc:" }));
  }
  assert.equal(seen.size, count);
});

test("pickIndex is stable for the same inputs and varies by key", () => {
  const a = pickIndex({ count: 50, day: "2026-09-14", key: "k1" });
  assert.equal(a, pickIndex({ count: 50, day: "2026-09-14", key: "k1" }));
  assert.ok(a >= 0 && a < 50);
  const different = Array.from({ length: 20 }, (_, i) => pickIndex({ count: 50, day: "2026-09-14", key: `k${i}` }));
  assert.ok(new Set(different).size > 1, "different salts should give different photos");
});

test("pickIndex edge cases", () => {
  assert.equal(pickIndex({ count: 0, day: "2026-09-14", key: "k" }), -1);
  assert.equal(pickIndex({ count: 1, day: "2026-09-14", key: "k" }), 0);
});

test("localDay respects the time zone", () => {
  const instant = new Date("2026-09-14T23:30:00Z");
  assert.equal(localDay(instant, "UTC"), "2026-09-14");
  assert.equal(localDay(instant, "Pacific/Auckland"), "2026-09-15");
  assert.equal(localDay(instant, "America/Los_Angeles"), "2026-09-14");
  assert.equal(localDay(instant, "Not/AZone"), null);
});

test("offsetDay shifts by seconds", () => {
  const instant = new Date("2026-09-14T23:30:00Z");
  assert.equal(offsetDay(instant, 3600), "2026-09-15");
  assert.equal(offsetDay(instant, -3600), "2026-09-14");
});

test("resolveDay preference order", () => {
  const now = new Date("2026-09-14T23:30:00Z");
  assert.deepEqual(resolveDay({ day: "2026-01-01", tz: "Pacific/Auckland", now }), { day: "2026-01-01", source: "param" });
  assert.equal(resolveDay({ tz: "Pacific/Auckland", now }).day, "2026-09-15");
  assert.equal(resolveDay({ tz: "Bogus/Zone", utcOffset: "3600", now }).day, "2026-09-15");
  assert.equal(resolveDay({ utcOffset: "not-a-number", now }).day, "2026-09-14");
  assert.equal(resolveDay({ now }).source, "utc");
  assert.throws(() => resolveDay({ day: "2026-13-01", now }), RangeError);
});
