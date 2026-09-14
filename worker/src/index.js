/**
 * TRMNL Apple Photos worker.
 *
 * Turns a public iCloud shared album into a tiny "photo of the day" JSON feed
 * that a TRMNL private plugin can poll. This is the optional self-hosted
 * alternative to running plugin/src/transform.js inside TRMNL's Serverless
 * runtime; both share the code in select.js, icloud.js and pick.js.
 *
 *   GET /photo?album=<link>   JSON describing today's photo (what TRMNL polls)
 *   GET /image?album=<link>   302 redirect to today's photo (handy for browsers / other frames)
 *   GET /album?album=<link>   album summary, for debugging a link
 *
 * Query parameters (all endpoints):
 *   album       shared album link or token (required)
 *   day         YYYY-MM-DD to force a day (default: today)
 *   tz          IANA time zone used to work out "today", e.g. Europe/London
 *   utc_offset  seconds east of UTC, used when tz is missing or unknown
 *   size        full (default) or thumb
 *   videos      include video poster frames: true/yes/1 (default: photos only)
 *   salt        any string; different salts give different daily orders
 *   strict      1 to return real HTTP error codes instead of 200 + {ok:false}
 */

import { fetchAlbum, parseAlbumRef } from "./icloud.js";
import { errorPayload, photoPayload, selectPhoto, truthy } from "./select.js";

const PHOTO_CACHE_SECONDS = 300; // signed Apple URLs live ~20 minutes; keep a wide margin
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
};

export function createHandler({ fetchImpl } = {}) {
  return {
    async fetch(request, _env, ctx) {
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ ok: false, error: "method_not_allowed", message: "Use GET." }, 405);
      }

      switch (url.pathname) {
        case "/":
          return usage(url);
        case "/photo":
          return withCache(request, ctx, () => photoResponse(url, { fetchImpl, redirect: false }));
        case "/image":
          return photoResponse(url, { fetchImpl, redirect: true });
        case "/album":
          return albumResponse(url, { fetchImpl });
        default:
          return json({ ok: false, error: "not_found", message: "Unknown path. See / for usage." }, 404);
      }
    },
  };
}

export default createHandler();

// ---------------------------------------------------------------------------

function readParams(url) {
  const q = url.searchParams;
  return {
    album: q.get("album") || q.get("url") || q.get("token") || "",
    day: q.get("day") || "",
    tz: q.get("tz") || "",
    utcOffset: q.get("utc_offset") ?? "",
    size: (q.get("size") || "full").toLowerCase(),
    videos: truthy(q.get("videos")),
    salt: q.get("salt") || "",
    strict: truthy(q.get("strict")),
  };
}

async function photoResponse(url, { fetchImpl, redirect }) {
  const params = readParams(url);
  let selection;
  try {
    selection = await selectPhoto(params, { fetchImpl });
  } catch (err) {
    return errorResponse(err, params, { redirect });
  }

  if (redirect) {
    return new Response(null, {
      status: 302,
      headers: {
        location: selection.imageUrl,
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    });
  }

  const imageEndpoint = new URL(url);
  imageEndpoint.pathname = "/image";
  imageEndpoint.search = url.search;

  const body = { ...photoPayload(selection), image_url: imageEndpoint.toString() };
  return json(body, 200, { "cache-control": `public, max-age=${PHOTO_CACHE_SECONDS}` });
}

async function albumResponse(url, { fetchImpl }) {
  const params = readParams(url);
  try {
    const ref = parseAlbumRef(params.album);
    const album = await fetchAlbum(ref, { fetchImpl });
    const photos = album.photos;
    return json({
      ok: true,
      album: {
        title: album.title,
        kind: album.kind,
        photo_count: photos.length,
        video_count: photos.filter((p) => p.isVideo).length,
        first_taken_at: photos[0]?.takenAt ?? null,
        last_taken_at: photos[photos.length - 1]?.takenAt ?? null,
        renditions_available: [...new Set(photos.flatMap((p) => Object.keys(p.renditions)))],
      },
    });
  } catch (err) {
    return errorResponse(err, params, { redirect: false });
  }
}

function errorResponse(err, params, { redirect }) {
  const { status, ...payload } = errorPayload(err);
  if (payload.error === "internal_error") console.error("Unhandled error", err);
  // TRMNL keeps rendering on 2xx only, so by default hand it a friendly
  // payload it can show on screen instead of a bare HTTP error.
  const httpStatus = redirect || params.strict ? status : 200;
  return json(payload, httpStatus, { "cache-control": "no-store" });
}

async function withCache(request, ctx, produce) {
  let cache = null;
  try {
    cache = globalThis.caches?.default ?? null;
  } catch {
    cache = null;
  }
  if (!cache) return produce();

  const key = new Request(request.url, { method: "GET" });
  try {
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch {
    // Cache unavailable. Fall through.
  }
  const response = await produce();
  if (response.ok) {
    try {
      const store = cache.put(key, response.clone());
      if (ctx?.waitUntil) ctx.waitUntil(store);
      else await store;
    } catch {
      // Ignore cache write failures.
    }
  }
  return response;
}

function usage(url) {
  const origin = url.origin;
  const text = [
    "TRMNL Apple Photos worker",
    "",
    "Shows one photo per day from a public iCloud shared album.",
    "",
    `GET ${origin}/photo?album=<shared album link>   JSON for TRMNL to poll`,
    `GET ${origin}/image?album=<shared album link>   redirects to today's photo`,
    `GET ${origin}/album?album=<shared album link>   album summary (debugging)`,
    "",
    "Optional query parameters: day=YYYY-MM-DD, tz=<IANA zone>, utc_offset=<seconds>,",
    "size=full|thumb, videos=true, salt=<any text>, strict=1",
    "",
    "Supported links:",
    "  https://photos.icloud.com/shared/album/<token>   (macOS 26 / iOS 26 and later)",
    "  https://www.icloud.com/sharedalbum/#<token>      (older systems)",
    "",
  ].join("\n");
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}
