/**
 * Photo-of-the-day selection shared by the Cloudflare Worker and the TRMNL
 * Serverless script. Everything here is plain data in, plain data out, so the
 * two deployment targets only differ in how they read their inputs.
 */
import { AlbumError, chooseRendition, fetchAlbum, parseAlbumRef } from "./icloud.js";
import { pickIndex, resolveDay } from "./pick.js";

/** Liberal boolean parsing for form fields and query strings. */
export function truthy(value) {
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
export async function selectPhoto(options, deps = {}) {
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
export function photoPayload({ album, candidates, dayInfo, index, photo, rendition, imageUrl }) {
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
export function errorPayload(err) {
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
