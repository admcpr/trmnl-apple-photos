import assert from "node:assert/strict";

export const CK_TOKEN = "06bVVxVSI16Dp22BBajWXkfkw";
export const SS_TOKEN = "B12GfnH8tC0ZuK";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake Apple that speaks both APIs well enough for the worker and the serverless script. */
export function fakeApple({ ckPhotos = 3, ssPhotos = 2, notPublic = false } = {}) {
  const calls = [];
  const zoneID = { zoneName: "SharedCollection-1", ownerRecordName: "_owner", zoneType: "REGULAR_CUSTOM_ZONE" };
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    const u = new URL(url);

    if (u.pathname.endsWith("/public/records/resolve")) {
      const token = u.searchParams.get("sharing_url_key");
      if (token !== CK_TOKEN) return jsonResponse({ results: [{ shortGUID: { value: token }, serverErrorCode: "NOT_FOUND" }] });
      const result = { shortGUID: { value: token }, zoneID, share: { fields: { "cloudkit.title": { value: "Test album" } } } };
      if (notPublic) result.requireAppleLogin = true;
      else result.anonymousPublicAccess = { token: "ACCESS", databasePartition: "https://p124-ckdatabasews.icloud.com:443", tokenTTL: 1200000 };
      return jsonResponse({ results: [result] });
    }

    if (u.pathname.endsWith("/shared/changes/zone")) {
      assert.equal(u.hostname, "p124-ckdatabasews.icloud.com");
      assert.equal(u.searchParams.get("publicAccessAuthToken"), "ACCESS");
      const body = JSON.parse(init.body);
      const page = body.zones[0].syncToken ? 1 : 0;
      const records = [];
      const perPage = Math.ceil(ckPhotos / 2);
      for (let i = page * perPage; i < Math.min(ckPhotos, (page + 1) * perPage); i++) {
        records.push({
          recordName: `m${i}`,
          recordType: "CPLMaster",
          fields: {
            itemType: { value: "public.jpeg" },
            resOriginalFileType: { value: "public.jpeg" },
            resOriginalWidth: { value: 1600 },
            resOriginalHeight: { value: 1200 },
            originalCreationDate: { value: 1718611850000 + i * 1000 },
            resOriginalRes: { value: { downloadURL: `https://cvws.icloud-content.com/B/m${i}/\${f}?e=1789399310`, size: 10 } },
            resJPEGThumbRes: { value: { downloadURL: `https://cvws.icloud-content.com/B/m${i}-t/\${f}?e=1789399310`, size: 1 } },
          },
        });
      }
      return jsonResponse({ zones: [{ zoneID, moreComing: page === 0 && ckPhotos > perPage, syncToken: "S1", records }] });
    }

    if (u.hostname.endsWith("-sharedstreams.icloud.com") && u.pathname.endsWith("/webstream")) {
      if (u.hostname !== "p140-sharedstreams.icloud.com") return jsonResponse({ "X-Apple-MMe-Host": "p140-sharedstreams.icloud.com" }, 330);
      if (!u.pathname.startsWith(`/${SS_TOKEN}/`)) return new Response("", { status: 404 });
      const photos = Array.from({ length: ssPhotos }, (_, i) => ({
        photoGuid: `G${i}`,
        dateCreated: `2016-11-0${i + 1}T12:00:00Z`,
        width: "1537",
        height: "2049",
        derivatives: {
          342: { checksum: `small${i}`, width: "257", height: "342", fileSize: "1" },
          2049: { checksum: `large${i}`, width: "1537", height: "2049", fileSize: "2" },
        },
      }));
      return jsonResponse({ streamName: "Sample photos", photos });
    }

    if (u.pathname.endsWith("/webasseturls")) {
      const body = JSON.parse(init.body);
      const guid = body.photoGuids[0];
      const i = guid.slice(1);
      return jsonResponse({
        locations: { "cvws.icloud-content.com": { scheme: "https", hosts: ["cvws.icloud-content.com"] } },
        items: {
          [`large${i}`]: { url_location: "cvws.icloud-content.com", url_path: `/S/large${i}/P.JPG?o=1`, url_expiry: "2026-09-14T18:13:02Z" },
          [`small${i}`]: { url_location: "cvws.icloud-content.com", url_path: `/S/small${i}/P.JPG?o=1`, url_expiry: "2026-09-14T18:13:02Z" },
        },
      });
    }

    throw new Error(`unexpected request ${url}`);
  };
  return { fetchImpl, calls };
}
