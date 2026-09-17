# TRMNL Apple Photos (Shared Album)

[![CI](https://github.com/admcpr/trmnl-apple-photos/actions/workflows/ci.yml/badge.svg)](https://github.com/admcpr/trmnl-apple-photos/actions/workflows/ci.yml)

A [TRMNL](https://trmnl.com) plugin that shows one photo per day from a public iCloud shared album. Every day it picks a different photo from the album, and the same photo stays on screen all day.

It works with the share links that current versions of macOS and iOS produce (`https://photos.icloud.com/shared/album/...`), which the existing first-party Apple Photos plugin does not understand, and it still works with the older `https://www.icloud.com/sharedalbum/#...` links.

Nothing needs hosting. The plugin runs entirely on trmnl.com using the private plugin **Polling** strategy plus TRMNL's **Serverless** runtime. A Cloudflare Worker is included as an optional alternative for people who would rather self-host.

## How it works

```
TRMNL polling ──POST──▶ Apple CloudKit "resolve" (album token → access token, partition, zone)
      │
      ▼
TRMNL Serverless runs transform.js ──▶ Apple "changes/zone" (lists the album)
      │                                 picks today's photo, returns ~1 KB of JSON
      ▼
Liquid templates render a full-bleed dithered photo
```

Apple's new share links are backed by CloudKit's public sharing API. Reading an album takes two calls: resolve the link token into an anonymous access token and database partition, then list the album zone. The image URLs Apple hands back are signed and expire after about 20 minutes, and album listings run to hundreds of kilobytes, so plain polling cannot do it alone. The Serverless script does the second call and the selection on TRMNL's side, inside its 5 second / 128 MB budget.

The daily choice is deterministic and needs no database. Days are grouped into cycles as long as the album, each cycle gets its own seeded shuffle of the photos, and day N shows the Nth entry of that shuffle. Within a cycle every photo appears exactly once, and the order changes on the next cycle.

## Repository layout

| Path | What it is |
| --- | --- |
| `plugin/src/settings.yml` | Plugin definition: polling config, form fields, serverless language |
| `plugin/src/transform.js` | **Generated** Serverless script (Node). Paste into TRMNL or push with trmnlp |
| `plugin/src/*.liquid` | One Liquid template per layout, plus shared markup |
| `plugin/.trmnlp.yml` | Local preview config for [trmnlp](https://github.com/usetrmnl/trmnlp) |
| `worker/src/icloud.js` | Readers for both generations of iCloud share links |
| `worker/src/pick.js` | Deterministic photo-of-the-day selection |
| `worker/src/select.js` | Selection and JSON payload shared by both targets |
| `worker/src/serverless-entry.js` | The `run(input)` entry point for TRMNL Serverless |
| `worker/src/index.js` | Optional Cloudflare Worker HTTP endpoints |
| `worker/scripts/build-serverless.mjs` | Concatenates the sources into `plugin/src/transform.js` |
| `worker/test/` | Unit tests against a fake Apple, for both targets |

## Setup (no server)

### 1. Make the album public

In Photos, open the shared album, click the people icon, and turn on **Public Website**. Copy the link it shows. Photos on macOS 26 or later gives a `photos.icloud.com/shared/album/...` link. Older systems give an `icloud.com/sharedalbum/#...` link. Both work.

### 2. Create the private plugin

Either import the plugin:

1. Download `apple-photos-plugin.zip` from the [latest release](https://github.com/admcpr/trmnl-apple-photos/releases/latest). CI rebuilds it on every push to `main`. To build it yourself instead, zip the contents of `plugin/src/` so the files sit at the top level of the zip:

   ```powershell
   Compress-Archive -Path plugin\src\* -DestinationPath apple-photos-plugin.zip -Force
   ```

2. On trmnl.com go to **Plugins → Private Plugin → Import new** and upload the zip.

Or build it by hand from the files: create a private plugin with strategy Polling, copy the polling URL, verb, headers and body from [settings.yml](plugin/src/settings.yml), paste the custom fields YAML, paste each Liquid file into its layout tab and `shared.liquid` into the Shared tab, then open the Serverless section, pick **Node**, and paste [transform.js](plugin/src/transform.js).

If the import did not pick up the Serverless script, paste `transform.js` into the Serverless editor afterwards. With the [trmnlp](https://github.com/usetrmnl/trmnlp) command line tool, `trmnlp login` then `trmnlp push` from `plugin/` uploads everything including the script.

### 3. Configure it

Open the plugin's settings, paste your album link, choose a photo fit, and save. Use **Force Refresh** to see the first photo. If something is wrong, turn on **Debug Logs** on the plugin settings page: the script returns a message such as "This album is not public" and the screen shows it.

### Settings the user sees

| Setting | Meaning |
| --- | --- |
| Shared album link | The public link to the album |
| Photo fit | Fill the screen and crop the edges, or show the whole photo with bars |
| Show album name and date | Adds a title bar with the album name and the date the photo was taken |
| Include videos | Videos are skipped by default. Turn on to include their still frames |
| Shuffle seed | Optional. Different seeds give different daily orders, so two devices can show different photos |

## What the script returns

`run(input)` returns the merge data the templates use:

```json
{
  "ok": true,
  "album": { "title": "Family", "kind": "cloudkit", "photo_count": 212, "candidate_count": 205 },
  "day": "2026-09-14",
  "day_source": "tz:Europe/London",
  "index": 17,
  "photo": {
    "id": "Aer7sHDIwbDDtDaCpn3rp5p0Bnfo",
    "url": "https://cvws-h2.icloud-content.com/B/.../photo.jpg?o=...&e=1789399310",
    "rendition": "original",
    "width": 1600, "height": 1200, "orientation": "landscape",
    "is_video": false, "is_favorite": false,
    "taken_at": "2024-06-17T08:10:50.000Z",
    "caption": "", "contributor": null,
    "expires_at": "2026-09-14T15:21:50.000Z"
  },
  "generated_at": "2026-09-14T15:02:00.000Z"
}
```

Errors come back as `{ "ok": false, "error": "not_public", "message": "..." }` and the templates show the message.

The day is worked out in the user's TRMNL time zone (`trmnl.user.time_zone_iana`), so the photo changes within an hour of local midnight at the default hourly refresh.

## Optional: self-hosted worker

If you would rather not use Serverless, or want an image URL for other frames, the same code runs as a Cloudflare Worker.

```bash
cd worker
npm install
npx wrangler login
npm run deploy
```

Then in `settings.yml` set the polling verb to `get`, remove the body and headers and serverless language, and point `polling_url` at:

```
https://trmnl-apple-photos.<your-subdomain>.workers.dev/photo?album={{ album_url | url_encode }}&tz={{ trmnl.user.time_zone_iana | url_encode }}&utc_offset={{ trmnl.user.utc_offset }}&videos={{ include_videos }}&salt={{ salt | url_encode }}
```

The worker serves `GET /photo` (the same JSON as above plus `image_url`), `GET /image` (302 redirect to today's photo) and `GET /album` (a summary for checking a link). Query parameters: `album`, `day`, `tz`, `utc_offset`, `size` (`full` or `thumb`), `videos`, `salt`, and `strict=1` for real HTTP error codes instead of `200` with `ok: false`. Responses are cached at the edge for 5 minutes.

## Development

```bash
cd worker
npm install
npm test               # rebuilds plugin/src/transform.js, then runs the unit tests (no network)
npm run build:serverless
npm run dev            # worker at http://localhost:8787
```

`transform.js` is generated from `worker/src/`. Edit the sources, not the bundle, and commit the rebuilt bundle: CI fails if the committed `transform.js` differs from what the sources produce.

The [CI workflow](.github/workflows/ci.yml) runs the build and tests on every push and pull request, uploads the plugin zip as a workflow artifact, and on `main` moves the `latest` tag and updates the "Latest build" GitHub release with the zip. To preview the screens, install trmnlp (Ruby, or Docker) and run `trmnlp serve` inside `plugin/`. `plugin/.trmnlp.yml` holds sample settings and enables the transform runtime, so previews use the real script.

## Apple API notes

There is no public documentation for either API. What the script does was worked out by watching what the iCloud web app does.

New links (`photos.icloud.com/shared/album/<token>`):

1. `POST https://ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production/public/records/resolve?sharing_url_key=<token>` with body `{"shortGUIDs":[{"value":"<token>"}]}`. The response has `anonymousPublicAccess.token`, `anonymousPublicAccess.databasePartition` (for example `https://p124-ckdatabasews.icloud.com:443`), the zone ID, and the album title. `requireAppleLogin: true` means the album is not public. The token lives 20 minutes.
2. `POST <partition>/database/1/com.apple.photos.cloud/production/shared/changes/zone?sharing_url_key=<token>&publicAccessAuthToken=<token>` with body `{"zones":[{"zoneID":...,"resultsLimit":200,"desiredKeys":[...]}]}`. Paginate with `syncToken` while `moreComing` is true. `CPLMaster` records hold the image renditions (`resJPEGThumbRes`, `resJPEGMedRes`, `resJPEGFullRes`, `resOriginalRes`) as signed `downloadURL`s with a `${f}` placeholder for the file name. `CPLAsset` records point at their master and carry the date taken. Without the access token the call fails with `AUTHENTICATION_FAILED`, and `records/query` is not available for these record types, which is why plain polling cannot do this.

Old links (`icloud.com/sharedalbum/#<token>`):

1. Work out a starting partition from the token, then `POST https://p<NN>-sharedstreams.icloud.com/<token>/sharedstreams/webstream` with `{"streamCtag":null}`. A `330` reply with `{"X-Apple-MMe-Host": "..."}` means retry against that host.
2. `POST .../sharedstreams/webasseturls` with `{"photoGuids":["..."]}` to get a signed URL per derivative checksum.

## Troubleshooting

- **"This album is not public"**: Public Website is off for the album. Turn it on in Photos and wait a minute.
- **"Album not found"**: the link is wrong or the album was deleted.
- **Blank screen, no message**: the Serverless script is probably missing or set to the wrong language. It must be Node. Check Debug Logs on the plugin settings page.
- **Photo looks stale**: the plugin polls hourly, so a new day's photo appears within an hour of midnight in your TRMNL time zone.
- **HEIC photos**: shared albums normally carry a JPEG rendition next to the HEIC original and the script prefers it. If Apple only offers a HEIC, it falls back to the thumbnail rather than an image the renderer cannot decode.
- **Very large albums**: the script lists the whole album on every poll, 200 records per request, within Serverless's 5 second limit. Measured from a home connection, a new-format album takes about 1.5 seconds for the two Apple calls. Albums of a few thousand photos should be fine; if the log shows a timeout, use the worker instead.
- **Old-format links are slower**: they need three Apple calls, and Apple's `webstream` endpoint alone took about 2.4 seconds in testing, for a total near 3.6 seconds. That fits the 5 second budget but with little margin. If an old-format album times out, share it again from a current macOS or iOS to get a new-format link, or use the worker.
