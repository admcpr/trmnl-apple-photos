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
