import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/index.js";
import { CK_TOKEN, SS_TOKEN, fakeApple } from "./fake-apple.js";


const get = (handler, path) => handler.fetch(new Request(`https://worker.test${path}`), {}, { waitUntil() {} });

test("/photo returns today's photo from a CloudKit album, paginating the zone", async () => {
  const apple = fakeApple({ ckPhotos: 3 });
  const handler = createHandler({ fetchImpl: apple.fetchImpl });
  const res = await get(handler, `/photo?album=${encodeURIComponent(`https://photos.icloud.com/shared/album/${CK_TOKEN}/`)}&day=2026-09-14`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.album.title, "Test album");
  assert.equal(body.album.kind, "cloudkit");
  assert.equal(body.album.photo_count, 3);
  assert.equal(body.day, "2026-09-14");
  assert.match(body.photo.url, /^https:\/\/cvws\.icloud-content\.com\/B\/m\d\/photo\.jpg\?e=1789399310$/);
  assert.equal(body.photo.rendition, "original");
  assert.equal(body.photo.orientation, "landscape");
  assert.equal(body.photo.expires_at, "2026-09-14T15:21:50.000Z");
  assert.match(body.image_url, /^https:\/\/worker\.test\/image\?album=/);
  assert.equal(apple.calls.filter((c) => c.url.includes("changes/zone")).length, 2, "two pages fetched");
  assert.ok(apple.calls.find((c) => c.url.includes("changes/zone")).body.zones[0].desiredKeys.includes("resJPEGFullRes"));
});

test("/photo is stable within a day and changes across days", async () => {
  const handler = createHandler({ fetchImpl: fakeApple({ ckPhotos: 10 }).fetchImpl });
  const album = encodeURIComponent(CK_TOKEN);
  const a = await (await get(handler, `/photo?album=${album}&day=2026-09-14`)).json();
  const b = await (await get(handler, `/photo?album=${album}&day=2026-09-14`)).json();
  assert.equal(a.photo.id, b.photo.id);
  const ids = new Set();
  for (let d = 1; d <= 10; d++) ids.add((await (await get(handler, `/photo?album=${album}&day=2026-09-${String(d).padStart(2, "0")}`)).json()).photo.id);
  assert.ok(ids.size > 1);
});

test("/photo works with a legacy sharedalbum link, following Apple's partition redirect", async () => {
  const apple = fakeApple();
  const handler = createHandler({ fetchImpl: apple.fetchImpl });
  const res = await get(handler, `/photo?album=${encodeURIComponent(`https://www.icloud.com/sharedalbum/#${SS_TOKEN}`)}&day=2026-09-14`);
  const body = await res.json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.album.kind, "sharedstreams");
  assert.equal(body.album.title, "Sample photos");
  assert.match(body.photo.url, /^https:\/\/cvws\.icloud-content\.com\/S\/large\d\/P\.JPG\?o=1$/);
  assert.equal(body.photo.rendition, "large");
  const hosts = apple.calls.filter((c) => c.url.includes("/webstream")).map((c) => new URL(c.url).hostname);
  assert.deepEqual(hosts, ["p64-sharedstreams.icloud.com", "p140-sharedstreams.icloud.com"]);
});

test("bare legacy token is auto-detected", async () => {
  const handler = createHandler({ fetchImpl: fakeApple().fetchImpl });
  const body = await (await get(handler, `/photo?album=${SS_TOKEN}&day=2026-09-14`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.album.kind, "sharedstreams");
});

test("/photo uses tz to work out the day", async () => {
  const handler = createHandler({ fetchImpl: fakeApple().fetchImpl });
  const body = await (await get(handler, `/photo?album=${CK_TOKEN}&tz=Pacific/Auckland`)).json();
  assert.equal(body.day_source, "tz:Pacific/Auckland");
  assert.match(body.day, /^\d{4}-\d{2}-\d{2}$/);
});

test("/photo size=thumb picks the thumbnail", async () => {
  const handler = createHandler({ fetchImpl: fakeApple().fetchImpl });
  const body = await (await get(handler, `/photo?album=${CK_TOKEN}&size=thumb&day=2026-09-14`)).json();
  assert.equal(body.photo.rendition, "thumb");
});

test("/image redirects to the photo", async () => {
  const handler = createHandler({ fetchImpl: fakeApple().fetchImpl });
  const res = await get(handler, `/image?album=${CK_TOKEN}&day=2026-09-14`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /^https:\/\/cvws\.icloud-content\.com\//);
});

test("/album summarises the album", async () => {
  const handler = createHandler({ fetchImpl: fakeApple({ ckPhotos: 4 }).fetchImpl });
  const body = await (await get(handler, `/album?album=${CK_TOKEN}`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.album.photo_count, 4);
  assert.deepEqual(body.album.renditions_available.sort(), ["original", "thumb"]);
});

test("errors are friendly 200s by default and real statuses with strict=1", async () => {
  const handler = createHandler({ fetchImpl: fakeApple().fetchImpl });

  let res = await get(handler, `/photo?album=`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).error, "missing_album");

  res = await get(handler, `/photo?album=https://example.com/nope`);
  assert.equal((await res.json()).error, "bad_album_url");

  res = await get(handler, `/photo?album=${encodeURIComponent("https://photos.icloud.com/shared/album/zzzzzzzzzz")}`);
  assert.equal((await res.json()).error, "not_found");

  res = await get(handler, `/photo?album=${CK_TOKEN}&day=2026-02-30`);
  assert.equal((await res.json()).error, "bad_day");

  res = await get(handler, `/photo?album=${encodeURIComponent("https://photos.icloud.com/shared/album/zzzzzzzzzz")}&strict=1`);
  assert.equal(res.status, 404);

  res = await get(handler, `/image?album=${encodeURIComponent("https://photos.icloud.com/shared/album/zzzzzzzzzz")}`);
  assert.equal(res.status, 404, "redirect endpoint always uses real status codes");

  res = await get(handler, `/nope`);
  assert.equal(res.status, 404);
});

test("a private album is reported as not_public", async () => {
  const handler = createHandler({ fetchImpl: fakeApple({ notPublic: true }).fetchImpl });
  const body = await (await get(handler, `/photo?album=${CK_TOKEN}`)).json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "not_public");
  assert.match(body.message, /Public Website/);
});

test("an empty album is reported", async () => {
  const handler = createHandler({ fetchImpl: fakeApple({ ckPhotos: 0 }).fetchImpl });
  const body = await (await get(handler, `/photo?album=${CK_TOKEN}`)).json();
  assert.equal(body.error, "empty_album");
});

test("/ prints usage", async () => {
  const handler = createHandler({ fetchImpl: fakeApple().fetchImpl });
  const res = await get(handler, "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /GET https:\/\/worker\.test\/photo/);
});
