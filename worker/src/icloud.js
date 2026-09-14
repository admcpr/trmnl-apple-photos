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

export class AlbumError extends Error {
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
export function parseAlbumRef(input) {
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
export function guessKind(token) {
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
export async function fetchAlbum(ref, { fetchImpl, resolved } = {}) {
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
export function chooseRendition(photo, size = "full") {
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
export function isResolveFor(body, token) {
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
export function photosFromCloudKitRecords(records) {
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
export function sharedStreamsHost(token) {
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
export function photosFromWebStream(items) {
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
