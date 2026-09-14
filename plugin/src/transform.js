/**
 * TRMNL Apple Photos, Serverless edition.
 *
 * GENERATED FILE. Do not edit by hand: change worker/src/*.js and run
 * `npm run build:serverless` in worker/.
 *
 * Paste this whole file into the plugin's Serverless editor (language: Node),
 * or keep it as plugin/src/transform.js for `trmnlp push`.
 */

// ---- icloud.js -------------------------------------------------------------
/**
 * Readers for publicly shared iCloud Photos albums.
 *
 * Apple has shipped two generations of public share links:
 *
 *  1. https://photos.icloud.com/shared/album/<token>   (macOS 26 / iOS 26 and later)
 *     Backed by CloudKit's public sharing API. The token is a CloudKit "short GUID".
 *     Flow: POST public/records/resolve  -> anonymous access token + database partition + zone
 *           POST shared/changes/zone      -> every record in the album zone (paginated)
 *     CPLMaster records carry signed download URLs that expire after ~20 minutes.
 *
 *  2. https://www.icloud.com/sharedalbum/#<token>      (older systems)
 *     Backed by the "sharedstreams" web API of the old iCloud shared-album page.
 *     Flow: POST <partition>-sharedstreams.icloud.com/<token>/sharedstreams/webstream
 *           (may answer 330 + {"X-Apple-MMe-Host": ...} pointing at the right partition)
 *           POST .../sharedstreams/webasseturls -> signed URL per derivative checksum
 *
 * Both are read-only and need no Apple credentials as long as the album has
 * "Public Website" turned on.
 */

class AlbumError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AlbumError";
    this.code = code;
    this.status = status;
  }
}

const TOKEN_RE = /^[A-Za-z0-9_-]{6,80}$/;
const UPSTREAM_TIMEOUT_MS = 15000;

/**
 * Accepts any of:
 *   https://photos.icloud.com/shared/album/06bVVxVSI16Dp22BBajWXkfkw/
 *   https://www.icloud.com/sharedalbum/#B12GfnH8tC0ZuK
 *   https://share.icloud.com/photos/<token>
 *   a bare token (with or without a leading '#')
 * and returns { kind: "cloudkit" | "sharedstreams" | "auto", token }.
 */
function parseAlbumRef(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new AlbumError("missing_album", "No shared album link was provided.");

  let url = null;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL. Maybe a bare token.
  }

  if (url) {
    let m;
    if ((m = url.pathname.match(/^\/shared\/album\/([A-Za-z0-9_-]+)/))) {
      return { kind: "cloudkit", token: m[1] };
    }
    if ((m = url.hash.match(/^#([A-Za-z0-9_-]+)/))) {
      return { kind: "sharedstreams", token: m[1] };
    }
    if ((m = url.pathname.match(/^\/photos\/([A-Za-z0-9_-]+)/))) {
      return { kind: "auto", token: m[1] };
    }
    throw new AlbumError(
      "bad_album_url",
      "That does not look like an iCloud shared album link. Expected https://photos.icloud.com/shared/album/... or https://www.icloud.com/sharedalbum/#..."
    );
  }

  const token = raw.replace(/^#/, "");
  if (!TOKEN_RE.test(token)) {
    throw new AlbumError("bad_album_url", "That does not look like an iCloud shared album link or token.");
  }
  return { kind: "auto", token };
}

/** Legacy sharedstreams tokens always start with the partition prefix letter A or B. */
function guessKind(token) {
  return /^[AB]/.test(token) ? "sharedstreams" : "cloudkit";
}

/**
 * Fetch the album for a parsed reference.
 * Returns { kind, token, title, photos, getUrl(photo, rendition) }.
 *
 * `resolved` may carry a CloudKit records/resolve response body that was
 * already fetched for this token (TRMNL's polling step does that); it is used
 * instead of a fresh resolve call when it matches.
 */
async function fetchAlbum(ref, { fetchImpl, resolved } = {}) {
  const f = fetchImpl || ((...args) => globalThis.fetch(...args));
  const order =
    ref.kind === "auto"
      ? guessKind(ref.token) === "sharedstreams"
        ? ["sharedstreams", "cloudkit"]
        : ["cloudkit", "sharedstreams"]
      : [ref.kind];

  let lastError;
  for (const kind of order) {
    try {
      return kind === "cloudkit"
        ? await fetchCloudKitAlbum(ref.token, f, resolved)
        : await fetchSharedStreamsAlbum(ref.token, f);
    } catch (err) {
      if (err instanceof AlbumError && err.code === "not_found" && order.length > 1) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

const RENDITION_ORDER = {
  full: ["large", "medium", "original", "thumb"],
  thumb: ["thumb", "medium", "large", "original"],
};

/** Pick the best rendition a browser can display for the requested size. */
function chooseRendition(photo, size = "full") {
  const order = RENDITION_ORDER[size] || RENDITION_ORDER.full;
  for (const name of order) {
    const r = photo.renditions[name];
    if (r && r.browserSafe !== false) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function postJson(fetchImpl, url, body, label) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AlbumError("upstream_unreachable", `Could not reach Apple (${label}): ${err.message}`, 502);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: res.status, data, text };
}

function toIso(value) {
  if (value == null || value === "") return null;
  const d = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function sortPhotos(photos) {
  return photos.sort((a, b) => {
    const ta = a.takenAt || "";
    const tb = b.takenAt || "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// CloudKit (photos.icloud.com/shared/album/<token>)
// ---------------------------------------------------------------------------

const CK_BASE = "https://ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production";
const CK_PAGE_SIZE = 200;
const CK_MAX_PAGES = 200;
const CK_DESIRED_KEYS = [
  "itemType",
  "originalOrientation",
  "originalCreationDate",
  "resOriginalFileType",
  "resOriginalRes",
  "resOriginalWidth",
  "resOriginalHeight",
  "resJPEGFullRes",
  "resJPEGFullWidth",
  "resJPEGFullHeight",
  "resJPEGMedRes",
  "resJPEGMedWidth",
  "resJPEGMedHeight",
  "resJPEGThumbRes",
  "resJPEGThumbWidth",
  "resJPEGThumbHeight",
  "masterRef",
  "assetDate",
  "addedDate",
  "orientation",
  "isHidden",
  "isFavorite",
];

/** True when `body` is a records/resolve response for exactly this token. */
function isResolveFor(body, token) {
  return body?.results?.[0]?.shortGUID?.value === token;
}

async function fetchCloudKitAlbum(token, fetchImpl, preResolved) {
  let resolved;
  if (isResolveFor(preResolved, token)) {
    resolved = { status: 200, data: preResolved };
  } else {
    const resolveQuery = new URLSearchParams({
      remapEnums: "true",
      getCurrentSyncToken: "true",
      sharing_url_key: token,
    });
    resolved = await postJson(
      fetchImpl,
      `${CK_BASE}/public/records/resolve?${resolveQuery}`,
      { shortGUIDs: [{ value: token }] },
      "records/resolve"
    );
  }
  const result = resolved.data?.results?.[0];
  const code = result?.serverErrorCode;
  if (resolved.status === 404 || !result || code === "NOT_FOUND" || code === "BAD_REQUEST") {
    throw new AlbumError("not_found", "Album not found. Check the link, and make sure the album is still shared.", 404);
  }
  if (resolved.status !== 200 || code) {
    throw new AlbumError("upstream_error", `Apple returned ${code || resolved.status} while resolving the album.`, 502);
  }
  const access = result.anonymousPublicAccess;
  if (result.requireAppleLogin || !access?.token || !access?.databasePartition) {
    throw new AlbumError(
      "not_public",
      'This album is not public. In Photos, open the shared album, choose the people icon, and turn on "Public Website".',
      403
    );
  }

  const zoneID = result.zoneID;
  const title = result.share?.fields?.["cloudkit.title"]?.value ?? null;
  const base = `${String(access.databasePartition).replace(/\/$/, "")}/database/1/com.apple.photos.cloud/production/shared`;
  const zoneQuery = new URLSearchParams({
    remapEnums: "true",
    getCurrentSyncToken: "true",
    sharing_url_key: token,
    publicAccessAuthToken: access.token,
  });

  const records = [];
  let syncToken;
  for (let page = 0; page < CK_MAX_PAGES; page++) {
    const zone = { zoneID, resultsLimit: CK_PAGE_SIZE, desiredKeys: CK_DESIRED_KEYS };
    if (syncToken) zone.syncToken = syncToken;
    const res = await postJson(fetchImpl, `${base}/changes/zone?${zoneQuery}`, { zones: [zone] }, "changes/zone");
    const z = res.data?.zones?.[0];
    if (res.status !== 200 || !z || z.serverErrorCode) {
      throw new AlbumError(
        "upstream_error",
        `Apple returned ${z?.serverErrorCode || res.status} while listing the album.`,
        502
      );
    }
    records.push(...(z.records || []));
    if (!z.moreComing || !z.syncToken) break;
    syncToken = z.syncToken;
  }

  return {
    kind: "cloudkit",
    token,
    title,
    photos: photosFromCloudKitRecords(records),
    async getUrl(_photo, rendition) {
      return rendition.url;
    },
  };
}

const CK_RENDITIONS = [
  ["resJPEGFull", "large"],
  ["resJPEGMed", "medium"],
  ["resOriginal", "original"],
  ["resJPEGThumb", "thumb"],
];

function fileExtension(fileType) {
  const t = String(fileType || "").toLowerCase();
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  if (t.includes("png")) return "png";
  if (t.includes("heic") || t.includes("heif")) return "heic";
  if (t.includes("gif")) return "gif";
  if (t.includes("webp")) return "webp";
  if (t.includes("quicktime")) return "mov";
  if (t.includes("mpeg-4") || t.includes("mp4")) return "mp4";
  return "bin";
}

function isBrowserSafe(fileType) {
  return /jpeg|jpg|png|gif|webp/i.test(String(fileType || ""));
}

/** Convert CloudKit zone records into the common photo shape. Exported for tests. */
function photosFromCloudKitRecords(records) {
  const assetsByMaster = new Map();
  for (const r of records) {
    if (r.recordType !== "CPLAsset" || r.deleted) continue;
    const masterName = r.fields?.masterRef?.value?.recordName;
    if (masterName) assetsByMaster.set(masterName, r);
  }

  const photos = [];
  for (const r of records) {
    if (r.recordType !== "CPLMaster" || r.deleted) continue;
    const f = r.fields || {};
    const asset = assetsByMaster.get(r.recordName);
    const af = asset?.fields || {};
    if (af.isHidden?.value) continue;

    const itemType = f.itemType?.value || f.resOriginalFileType?.value || "";
    const isVideo = /movie|video|mpeg-4|mp4/i.test(itemType);

    const renditions = {};
    for (const [prefix, name] of CK_RENDITIONS) {
      const res = f[`${prefix}Res`]?.value;
      if (!res?.downloadURL) continue;
      const fileType = name === "original" ? f.resOriginalFileType?.value || itemType : "public.jpeg";
      const filename = encodeURIComponent(`photo.${fileExtension(fileType)}`);
      renditions[name] = {
        name,
        url: String(res.downloadURL).replace("${f}", filename),
        width: Number(f[`${prefix}Width`]?.value) || 0,
        height: Number(f[`${prefix}Height`]?.value) || 0,
        bytes: Number(res.size) || 0,
        fileType,
        browserSafe: isBrowserSafe(fileType),
      };
    }
    if (Object.keys(renditions).length === 0) continue;

    const exifOrientation = Number(f.originalOrientation?.value ?? af.orientation?.value) || 1;
    let width = Number(f.resOriginalWidth?.value) || renditions.large?.width || renditions.thumb?.width || 0;
    let height = Number(f.resOriginalHeight?.value) || renditions.large?.height || renditions.thumb?.height || 0;
    if (exifOrientation >= 5) [width, height] = [height, width];

    photos.push({
      id: r.recordName,
      takenAt: toIso(af.assetDate?.value ?? f.originalCreationDate?.value),
      addedAt: toIso(af.addedDate?.value),
      isVideo,
      isFavorite: Boolean(af.isFavorite?.value),
      width,
      height,
      caption: "",
      contributor: null,
      renditions,
    });
  }
  return sortPhotos(photos);
}

// ---------------------------------------------------------------------------
// Legacy sharedstreams (www.icloud.com/sharedalbum/#<token>)
// ---------------------------------------------------------------------------

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SS_MAX_HOPS = 4;

/** Initial partition host derived from the token. Apple may still redirect us. */
function sharedStreamsHost(token) {
  const b62 = (s) => [...s].reduce((n, c) => n * 62 + Math.max(0, BASE62.indexOf(c)), 0);
  const n = token[0] === "A" ? b62(token.slice(1, 2)) : b62(token.slice(1, 3));
  return `p${String(n).padStart(2, "0")}-sharedstreams.icloud.com`;
}

async function fetchSharedStreamsAlbum(token, fetchImpl) {
  let host = sharedStreamsHost(token);
  for (let hop = 0; hop < SS_MAX_HOPS; hop++) {
    const res = await postJson(
      fetchImpl,
      `https://${host}/${token}/sharedstreams/webstream`,
      { streamCtag: null },
      "webstream"
    );
    const nextHost = res.data?.["X-Apple-MMe-Host"];
    if (nextHost) {
      host = String(nextHost);
      continue;
    }
    if (res.status === 404) {
      throw new AlbumError("not_found", "Album not found. Check the link, and make sure the album is still shared.", 404);
    }
    if (res.status !== 200 || !Array.isArray(res.data?.photos)) {
      throw new AlbumError("upstream_error", `Apple returned ${res.status} while listing the album.`, 502);
    }

    const streamHost = host;
    return {
      kind: "sharedstreams",
      token,
      title: res.data.streamName ?? null,
      photos: photosFromWebStream(res.data.photos),
      async getUrl(photo, rendition) {
        const assets = await postJson(
          fetchImpl,
          `https://${streamHost}/${token}/sharedstreams/webasseturls`,
          { photoGuids: [photo.id] },
          "webasseturls"
        );
        const item = assets.data?.items?.[rendition.checksum];
        if (assets.status !== 200 || !item?.url_location || !item?.url_path) {
          throw new AlbumError("upstream_error", "Apple did not return a download URL for the photo.", 502);
        }
        const scheme = assets.data.locations?.[item.url_location]?.scheme || "https";
        return `${scheme}://${item.url_location}${item.url_path}`;
      },
    };
  }
  throw new AlbumError("upstream_error", "Apple redirected the album request too many times.", 502);
}

/** Convert legacy webstream photos into the common photo shape. Exported for tests. */
function photosFromWebStream(items) {
  const photos = [];
  for (const p of items || []) {
    if (!p?.photoGuid) continue;
    const derivatives = Object.entries(p.derivatives || {})
      .map(([key, d]) => ({
        key,
        checksum: d?.checksum,
        width: Number(d?.width) || 0,
        height: Number(d?.height) || 0,
        bytes: Number(d?.fileSize) || 0,
        fileType: "public.jpeg",
        browserSafe: true,
      }))
      .filter((d) => d.checksum)
      .sort((a, b) => a.width * a.height - b.width * b.height);
    if (derivatives.length === 0) continue;

    const renditions = {
      thumb: { ...derivatives[0], name: "thumb" },
      large: { ...derivatives[derivatives.length - 1], name: "large" },
    };
    if (derivatives.length > 2) {
      renditions.medium = { ...derivatives[Math.floor(derivatives.length / 2)], name: "medium" };
    }

    photos.push({
      id: p.photoGuid,
      takenAt: toIso(p.dateCreated),
      addedAt: toIso(p.batchDateCreated),
      isVideo: p.mediaAssetType === "video",
      isFavorite: false,
      width: Number(p.width) || renditions.large.width,
      height: Number(p.height) || renditions.large.height,
      caption: p.caption || "",
      contributor: p.contributorFullName || null,
      renditions,
    });
  }
  return sortPhotos(photos);
}


// ---- pick.js ---------------------------------------------------------------
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
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Small, fast seeded PRNG (mulberry32). Returns a function yielding [0, 1). */
function mulberry32(seed) {
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
function seededOrder(n, seed) {
  const order = Array.from({ length: n }, (_, i) => i);
  const rand = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidDay(day) {
  const m = DAY_RE.exec(String(day || ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Days since 1970-01-01 for a YYYY-MM-DD string. */
function dayNumber(day) {
  const m = DAY_RE.exec(day);
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

/** YYYY-MM-DD for `date` in an IANA time zone. Returns null for an unknown zone. */
function localDay(date, timeZone) {
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
function offsetDay(date, utcOffsetSeconds) {
  return new Date(date.getTime() + utcOffsetSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Work out which calendar day to use, in order of preference:
 *   explicit `day` -> IANA `tz` -> `utcOffset` seconds -> UTC.
 */
function resolveDay({ day, tz, utcOffset, now = new Date() }) {
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
function pickIndex({ count, day, key }) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  if (count === 1) return 0;
  const n = dayNumber(day);
  const cycle = Math.floor(n / count);
  const order = seededOrder(count, fnv1a(`${key}|${cycle}`));
  return order[((n % count) + count) % count];
}


// ---- select.js -------------------------------------------------------------
/**
 * Photo-of-the-day selection shared by the Cloudflare Worker and the TRMNL
 * Serverless script. Everything here is plain data in, plain data out, so the
 * two deployment targets only differ in how they read their inputs.
 */


/** Liberal boolean parsing for form fields and query strings. */
function truthy(value) {
  return /^(1|true|yes|on|include)$/i.test(String(value ?? "").trim());
}

/**
 * options:
 *   album      shared album link or token (required)
 *   day        YYYY-MM-DD override
 *   tz         IANA time zone for "today"
 *   utcOffset  seconds east of UTC, fallback for tz
 *   size       "full" | "thumb"
 *   videos     include video still frames
 *   salt       extra text mixed into the daily order
 * deps:
 *   fetchImpl  fetch-compatible function
 *   resolved   optional CloudKit records/resolve response already fetched for this album
 */
async function selectPhoto(options, deps = {}) {
  const ref = parseAlbumRef(options.album);
  const album = await fetchAlbum(ref, deps);

  let candidates = options.videos ? album.photos : album.photos.filter((p) => !p.isVideo);
  if (candidates.length === 0) candidates = album.photos; // album is videos only
  if (candidates.length === 0) {
    throw new AlbumError("empty_album", "The shared album has no photos yet.", 404);
  }

  let dayInfo;
  try {
    dayInfo = resolveDay({ day: options.day, tz: options.tz, utcOffset: options.utcOffset });
  } catch (err) {
    throw new AlbumError("bad_day", err.message, 400);
  }

  const salt = String(options.salt ?? "");
  const index = pickIndex({
    count: candidates.length,
    day: dayInfo.day,
    key: `${album.kind}:${album.token}:${salt}`,
  });
  const photo = candidates[index];
  const size = options.size === "thumb" ? "thumb" : "full";
  const rendition = chooseRendition(photo, size);
  if (!rendition) {
    throw new AlbumError("no_rendition", "Apple did not provide a browser-viewable version of this photo.", 502);
  }
  const imageUrl = await album.getUrl(photo, rendition);

  return { album, candidates, dayInfo, index, photo, rendition, imageUrl };
}

/** The JSON both the worker and the serverless script hand to the Liquid templates. */
function photoPayload({ album, candidates, dayInfo, index, photo, rendition, imageUrl }) {
  const width = rendition.width || photo.width || null;
  const height = rendition.height || photo.height || null;
  return {
    ok: true,
    album: {
      title: album.title,
      kind: album.kind,
      photo_count: album.photos.length,
      candidate_count: candidates.length,
    },
    day: dayInfo.day,
    day_source: dayInfo.source,
    index,
    photo: {
      id: photo.id,
      url: imageUrl,
      rendition: rendition.name,
      width,
      height,
      orientation: orientationOf(width, height),
      is_video: photo.isVideo,
      is_favorite: photo.isFavorite,
      taken_at: photo.takenAt,
      caption: photo.caption || "",
      contributor: photo.contributor,
      expires_at: expiryOf(imageUrl),
    },
    generated_at: new Date().toISOString(),
  };
}

/** Friendly error payload. `status` is the HTTP status the worker would use. */
function errorPayload(err) {
  if (err instanceof AlbumError) {
    return { ok: false, error: err.code, message: err.message, status: err.status };
  }
  return {
    ok: false,
    error: "internal_error",
    message: "Something went wrong while fetching the album.",
    status: 500,
    detail: err && err.message ? String(err.message) : undefined,
  };
}

function orientationOf(width, height) {
  if (!width || !height) return null;
  if (width === height) return "square";
  return width > height ? "landscape" : "portrait";
}

/** Signed Apple URLs carry an expiry as `e=<unix seconds>`. */
function expiryOf(imageUrl) {
  try {
    const e = new URL(imageUrl).searchParams.get("e");
    if (e && /^\d+$/.test(e)) return new Date(Number(e) * 1000).toISOString();
  } catch {
    // ignore
  }
  return null;
}


// ---- serverless-entry.js ---------------------------------------------------
/**
 * Entry point for TRMNL's Serverless runtime (Node 20). TRMNL calls
 * `run(input)` after polling and hands whatever it returns to the Liquid
 * templates as merge data.
 *
 * `input` carries the polled response, the `trmnl` globals (user, device,
 * plugin settings) and the plugin's custom form field values. The plugin polls
 * Apple's CloudKit resolve endpoint, so for new-style links the first Apple
 * round trip is already in `input`; the script reuses it when it matches the
 * configured album and otherwise fetches everything itself.
 */

function serverlessSetting(input, key) {
  const fromFields = input?.trmnl?.plugin_settings?.custom_fields_values?.[key];
  if (fromFields !== undefined && fromFields !== null && fromFields !== "") return fromFields;
  const fromTop = input?.[key];
  if (fromTop !== undefined && fromTop !== null && fromTop !== "") return fromTop;
  return undefined;
}

/** The polled CloudKit resolve response, wherever TRMNL put it. */
function serverlessPolledResolve(input) {
  for (const candidate of [input, input?.data, input?.IDX_0]) {
    if (candidate && Array.isArray(candidate.results)) return candidate;
  }
  return null;
}

async function run(input) {
  input = input || {};
  const user = input.trmnl?.user || {};
  const options = {
    album: serverlessSetting(input, "album_url"),
    tz: user.time_zone_iana,
    utcOffset: user.utc_offset,
    size: String(serverlessSetting(input, "size") ?? "full"),
    videos: truthy(serverlessSetting(input, "include_videos")),
    salt: serverlessSetting(input, "salt") ?? "",
    day: serverlessSetting(input, "day"),
  };
  try {
    const selection = await selectPhoto(options, {
      fetchImpl: (...args) => fetch(...args),
      resolved: serverlessPolledResolve(input),
    });
    return photoPayload(selection);
  } catch (err) {
    return errorPayload(err);
  }
}
