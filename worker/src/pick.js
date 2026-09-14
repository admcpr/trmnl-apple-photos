/**
 * Deterministic "photo of the day" selection.
 *
 * Every day maps to exactly one photo, with no storage:
 *   - Days are numbered from the Unix epoch.
 *   - Days are grouped into cycles of `count` days.
 *   - Each cycle gets its own seeded shuffle of the photo indexes.
 *   - Day N shows shuffled[N % count].
 * So within one cycle every photo appears exactly once, in a random-looking
 * order, and the order changes on the next cycle. Adding or removing photos
 * changes `count` and therefore reshuffles, which is fine for a photo frame.
 */

/** 32-bit FNV-1a hash of a string. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Small, fast seeded PRNG (mulberry32). Returns a function yielding [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle of [0, n) driven by a seed. */
export function seededOrder(n, seed) {
  const order = Array.from({ length: n }, (_, i) => i);
  const rand = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDay(day) {
  const m = DAY_RE.exec(String(day || ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Days since 1970-01-01 for a YYYY-MM-DD string. */
export function dayNumber(day) {
  const m = DAY_RE.exec(day);
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

/** YYYY-MM-DD for `date` in an IANA time zone. Returns null for an unknown zone. */
export function localDay(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return null;
  }
}

/** YYYY-MM-DD for `date` shifted by a UTC offset in seconds. */
export function offsetDay(date, utcOffsetSeconds) {
  return new Date(date.getTime() + utcOffsetSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Work out which calendar day to use, in order of preference:
 *   explicit `day` -> IANA `tz` -> `utcOffset` seconds -> UTC.
 */
export function resolveDay({ day, tz, utcOffset, now = new Date() }) {
  if (day) {
    if (!isValidDay(day)) throw new RangeError(`Invalid day "${day}", expected YYYY-MM-DD.`);
    return { day, source: "param" };
  }
  if (tz) {
    const d = localDay(now, tz);
    if (d) return { day: d, source: `tz:${tz}` };
  }
  if (utcOffset !== undefined && utcOffset !== null && utcOffset !== "") {
    const seconds = Number(utcOffset);
    if (Number.isFinite(seconds) && Math.abs(seconds) <= 14 * 3600) {
      return { day: offsetDay(now, seconds), source: `utc_offset:${seconds}` };
    }
  }
  return { day: now.toISOString().slice(0, 10), source: "utc" };
}

/** Index of the photo to show on `day`, for a list of `count` photos. */
export function pickIndex({ count, day, key }) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  if (count === 1) return 0;
  const n = dayNumber(day);
  const cycle = Math.floor(n / count);
  const order = seededOrder(count, fnv1a(`${key}|${cycle}`));
  return order[((n % count) + count) % count];
}
