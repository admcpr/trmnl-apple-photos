import test from "node:test";
import assert from "node:assert/strict";
import { buildBundle } from "../scripts/build-serverless.mjs";
import { fakeApple, CK_TOKEN, SS_TOKEN } from "./fake-apple.js";

/** Evaluate the generated bundle the way TRMNL's runtime would, with `fetch` swapped for the fake Apple. */
function loadRun(fetchImpl) {
  const code = buildBundle();
  assert.ok(!/^\s*(import|export)\s/m.test(code), "bundle must not contain module syntax");
  const factory = new Function("fetch", `${code}\n;return run;`);
  return factory(fetchImpl);
}

function inputFor(fields, extra = {}) {
  return {
    trmnl: {
      user: { time_zone_iana: "Europe/London", utc_offset: 3600 },
      plugin_settings: { instance_name: "Apple Photos", custom_fields_values: fields },
    },
    ...extra,
  };
}

test("run() returns a photo payload for a CloudKit album using only the form fields", async () => {
  const apple = fakeApple({ ckPhotos: 5 });
  const run = loadRun(apple.fetchImpl);
  const out = await run(inputFor({ album_url: `https://photos.icloud.com/shared/album/${CK_TOKEN}/`, day: "2026-09-14" }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.album.kind, "cloudkit");
  assert.equal(out.album.photo_count, 5);
  assert.equal(out.day, "2026-09-14");
  assert.match(out.photo.url, /^https:\/\/cvws\.icloud-content\.com\/B\/m\d\/photo\.jpg/);
  assert.equal(out.photo.rendition, "original");
  assert.equal(apple.calls.filter((c) => c.url.includes("records/resolve")).length, 1);
});

test("run() reuses the polled resolve response and skips its own resolve call", async () => {
  const apple = fakeApple({ ckPhotos: 1 });
  const run = loadRun(apple.fetchImpl);
  const polled = await (await apple.fetchImpl(
    `https://ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production/public/records/resolve?sharing_url_key=${CK_TOKEN}`,
    { method: "POST", body: JSON.stringify({ shortGUIDs: [{ value: CK_TOKEN }] }) }
  )).json();
  apple.calls.length = 0;
  const out = await run(inputFor({ album_url: CK_TOKEN }, polled));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(apple.calls.filter((c) => c.url.includes("records/resolve")).length, 0, "resolve reused from input");
  assert.equal(apple.calls.filter((c) => c.url.includes("changes/zone")).length, 1);
});

test("run() ignores a polled resolve response for a different album", async () => {
  const apple = fakeApple({ ckPhotos: 2 });
  const run = loadRun(apple.fetchImpl);
  const stale = { results: [{ shortGUID: { value: "someOtherToken" }, anonymousPublicAccess: { token: "STALE", databasePartition: "https://p1-ckdatabasews.icloud.com:443" } }] };
  const out = await run(inputFor({ album_url: CK_TOKEN }, stale));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(apple.calls.filter((c) => c.url.includes("records/resolve")).length, 1);
});

test("run() handles legacy links, uses the user's time zone and reads top-level fields too", async () => {
  const apple = fakeApple();
  const run = loadRun(apple.fetchImpl);
  const out = await run({ album_url: `https://www.icloud.com/sharedalbum/#${SS_TOKEN}`, trmnl: { user: { time_zone_iana: "Pacific/Auckland" } } });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.album.kind, "sharedstreams");
  assert.equal(out.day_source, "tz:Pacific/Auckland");
});

test("run() returns a friendly error instead of throwing", async () => {
  const run = loadRun(fakeApple({ notPublic: true }).fetchImpl);
  let out = await run(inputFor({ album_url: CK_TOKEN }));
  assert.equal(out.ok, false);
  assert.equal(out.error, "not_public");
  assert.match(out.message, /Public Website/);

  out = await run(inputFor({}));
  assert.equal(out.error, "missing_album");

  out = await run(undefined);
  assert.equal(out.error, "missing_album");

  out = await run(inputFor({ album_url: "https://example.com/nope" }));
  assert.equal(out.error, "bad_album_url");
});
