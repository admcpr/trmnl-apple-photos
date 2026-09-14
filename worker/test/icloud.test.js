import test from "node:test";
import assert from "node:assert/strict";
import {
  AlbumError,
  chooseRendition,
  guessKind,
  parseAlbumRef,
  photosFromCloudKitRecords,
  photosFromWebStream,
  sharedStreamsHost,
} from "../src/icloud.js";

test("parseAlbumRef understands every link shape", () => {
  assert.deepEqual(parseAlbumRef("https://photos.icloud.com/shared/album/06bVVxVSI16Dp22BBajWXkfkw/"), {
    kind: "cloudkit",
    token: "06bVVxVSI16Dp22BBajWXkfkw",
  });
  assert.deepEqual(parseAlbumRef("https://photos.icloud.com/shared/album/06bVVxVSI16Dp22BBajWXkfkw"), {
    kind: "cloudkit",
    token: "06bVVxVSI16Dp22BBajWXkfkw",
  });
  assert.deepEqual(parseAlbumRef("https://www.icloud.com/sharedalbum/#B12GfnH8tC0ZuK"), {
    kind: "sharedstreams",
    token: "B12GfnH8tC0ZuK",
  });
  assert.deepEqual(parseAlbumRef("https://share.icloud.com/photos/B12GfnH8tC0ZuK"), {
    kind: "auto",
    token: "B12GfnH8tC0ZuK",
  });
  assert.deepEqual(parseAlbumRef("  #B12GfnH8tC0ZuK "), { kind: "auto", token: "B12GfnH8tC0ZuK" });
  assert.deepEqual(parseAlbumRef("06bVVxVSI16Dp22BBajWXkfkw"), { kind: "auto", token: "06bVVxVSI16Dp22BBajWXkfkw" });
});

test("parseAlbumRef rejects junk", () => {
  for (const bad of ["", "   ", "https://example.com/", "https://www.icloud.com/sharedalbum/", "not a token!"]) {
    assert.throws(() => parseAlbumRef(bad), AlbumError, bad);
  }
});

test("guessKind and sharedStreamsHost", () => {
  assert.equal(guessKind("B12GfnH8tC0ZuK"), "sharedstreams");
  assert.equal(guessKind("A5abc"), "sharedstreams");
  assert.equal(guessKind("06bVVxVSI16Dp22BBajWXkfkw"), "cloudkit");
  assert.equal(sharedStreamsHost("B12GfnH8tC0ZuK"), "p64-sharedstreams.icloud.com");
  assert.equal(sharedStreamsHost("A5abc"), "p05-sharedstreams.icloud.com");
});

function ckMaster(name, overrides = {}) {
  const url = (id) => `https://cvws.icloud-content.com/B/${id}/\${f}?o=abc&e=1789399310`;
  return {
    recordName: name,
    recordType: "CPLMaster",
    deleted: false,
    fields: {
      itemType: { value: "public.jpeg", type: "STRING" },
      originalOrientation: { value: 1, type: "INT64" },
      originalCreationDate: { value: 1718611850000, type: "TIMESTAMP" },
      resOriginalFileType: { value: "public.jpeg", type: "STRING" },
      resOriginalWidth: { value: 1600, type: "INT64" },
      resOriginalHeight: { value: 1200, type: "INT64" },
      resOriginalRes: { value: { downloadURL: url(name + "-orig"), size: 535604 }, type: "ASSETID" },
      resJPEGThumbWidth: { value: 480, type: "INT64" },
      resJPEGThumbHeight: { value: 360, type: "INT64" },
      resJPEGThumbRes: { value: { downloadURL: url(name + "-thumb"), size: 85984 }, type: "ASSETID" },
      ...overrides,
    },
  };
}

function ckAsset(id, masterName, overrides = {}) {
  return {
    recordName: id,
    recordType: "CPLAsset",
    deleted: false,
    fields: {
      masterRef: { value: { recordName: masterName }, type: "REFERENCE" },
      assetDate: { value: 1718611850000, type: "TIMESTAMP" },
      addedDate: { value: 1788524202133, type: "TIMESTAMP" },
      isHidden: { value: 0, type: "INT64" },
      isFavorite: { value: 0, type: "INT64" },
      ...overrides,
    },
  };
}

test("photosFromCloudKitRecords maps masters, fills the filename placeholder and sorts by date", () => {
  const records = [
    { recordName: "PrimarySync-0000-LI", recordType: "CPLLibraryInfo", fields: {} },
    ckMaster("m2", { originalCreationDate: { value: 1718700000000, type: "TIMESTAMP" } }),
    ckAsset("a2", "m2", { assetDate: { value: 1718700000000, type: "TIMESTAMP" }, isFavorite: { value: 1, type: "INT64" } }),
    ckMaster("m1"),
    ckAsset("a1", "m1"),
    ckMaster("deleted", { }),
  ];
  records[5].deleted = true;

  const photos = photosFromCloudKitRecords(records);
  assert.deepEqual(photos.map((p) => p.id), ["m1", "m2"]);
  const p = photos[0];
  assert.equal(p.takenAt, "2024-06-17T08:10:50.000Z");
  assert.equal(p.addedAt, "2026-09-04T12:16:42.133Z");
  assert.equal(p.width, 1600);
  assert.equal(p.height, 1200);
  assert.equal(p.isVideo, false);
  assert.equal(photos[1].isFavorite, true);
  assert.equal(p.renditions.original.url, "https://cvws.icloud-content.com/B/m1-orig/photo.jpg?o=abc&e=1789399310");
  assert.equal(p.renditions.thumb.width, 480);
  assert.ok(!("large" in p.renditions));
});

test("photosFromCloudKitRecords skips hidden assets and handles HEIC originals and videos", () => {
  const heic = ckMaster("heic", {
    itemType: { value: "public.heic", type: "STRING" },
    resOriginalFileType: { value: "public.heic", type: "STRING" },
    resJPEGFullWidth: { value: 2048, type: "INT64" },
    resJPEGFullHeight: { value: 1536, type: "INT64" },
    resJPEGFullRes: { value: { downloadURL: "https://x/${f}?e=1", size: 1 }, type: "ASSETID" },
  });
  const video = ckMaster("vid", {
    itemType: { value: "com.apple.quicktime-movie", type: "STRING" },
    resOriginalFileType: { value: "com.apple.quicktime-movie", type: "STRING" },
  });
  const rotated = ckMaster("rot", { originalOrientation: { value: 6, type: "INT64" } });
  const hidden = ckMaster("hid");
  const photos = photosFromCloudKitRecords([
    heic,
    video,
    rotated,
    hidden,
    ckAsset("ah", "hid", { isHidden: { value: 1, type: "INT64" } }),
  ]);
  const byId = Object.fromEntries(photos.map((p) => [p.id, p]));
  assert.ok(!("hid" in byId));

  assert.equal(byId.heic.renditions.original.browserSafe, false);
  assert.equal(byId.heic.renditions.original.url, "https://cvws.icloud-content.com/B/heic-orig/photo.heic?o=abc&e=1789399310");
  assert.equal(chooseRendition(byId.heic, "full").name, "large");
  assert.equal(chooseRendition(byId.heic, "thumb").name, "thumb");

  assert.equal(byId.vid.isVideo, true);
  assert.equal(chooseRendition(byId.vid, "full").name, "thumb", "video original is not browser-safe");

  assert.equal(byId.rot.width, 1200);
  assert.equal(byId.rot.height, 1600);
});

test("photosFromWebStream maps legacy derivatives", () => {
  const photos = photosFromWebStream([
    {
      photoGuid: "B",
      dateCreated: "2016-11-03T12:49:49Z",
      batchDateCreated: "2022-10-25T17:13:49Z",
      width: "1537",
      height: "2049",
      caption: "Hi",
      contributorFullName: "Maythee A",
      derivatives: {
        342: { fileSize: "43050", checksum: "c-small", width: "257", height: "342" },
        2049: { fileSize: "985681", checksum: "c-large", width: "1537", height: "2049" },
      },
    },
    { photoGuid: "A", dateCreated: "2015-01-01T00:00:00Z", derivatives: { 1: { checksum: "x", width: "1", height: "1" } } },
    { photoGuid: "V", mediaAssetType: "video", derivatives: { 1: { checksum: "v", width: "1", height: "1" } } },
    { photoGuid: "empty", derivatives: {} },
  ]);
  assert.deepEqual(photos.map((p) => p.id), ["V", "A", "B"]);
  const b = photos[2];
  assert.equal(b.renditions.large.checksum, "c-large");
  assert.equal(b.renditions.thumb.checksum, "c-small");
  assert.equal(b.caption, "Hi");
  assert.equal(b.contributor, "Maythee A");
  assert.equal(chooseRendition(b, "full").checksum, "c-large");
  assert.equal(photos[0].isVideo, true);
});
