import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const pluginSrc = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "src");
const settingsText = readFileSync(resolve(pluginSrc, "settings.yml"), "utf8");

/** Every `{{ ... }}` must close on the same line: a YAML comment or quoting slip truncates the Liquid. */
function assertBalancedLiquid(text, label) {
  for (const line of String(text).split("\n")) {
    const opens = (line.match(/\{\{/g) || []).length;
    const closes = (line.match(/\}\}/g) || []).length;
    assert.equal(opens, closes, `${label}: unbalanced {{ }} in: ${line}`);
  }
}

test("settings.yml parses as YAML with the keys TRMNL's importer needs", () => {
  const settings = yaml.load(settingsText);
  assert.equal(typeof settings, "object");
  assert.equal(settings.name, "Apple Photos (Shared Album)");
  assert.equal(settings.strategy, "polling");
  assert.equal(settings.polling_verb, "post");
  assert.equal(settings.serverless_language, "node");
  assert.ok([15, 60, 360, 720, 1440].includes(settings.refresh_interval), "refresh_interval must be one TRMNL accepts");
  assert.ok(["yes", "no"].includes(settings.no_screen_padding));
  assert.ok(["yes", "no"].includes(settings.dark_mode));
  assert.ok(Array.isArray(settings.custom_fields));
});

test("polling URL and body survive YAML parsing intact", () => {
  const settings = yaml.load(settingsText);
  assert.match(settings.polling_url, /^https:\/\/ckdatabasews\.icloud\.com\/.*records\/resolve\?/);
  assert.match(settings.polling_url, /sharing_url_key=\{\{ album_url .*\| first \}\}$/);
  assertBalancedLiquid(settings.polling_url, "polling_url");

  const body = settings.polling_body;
  assertBalancedLiquid(body, "polling_body");
  // With the Liquid replaced by a token, the body must be valid JSON of the shape Apple expects.
  const rendered = body.replace(/\{\{[^}]*\}\}/g, "TOKEN");
  assert.deepEqual(JSON.parse(rendered), { shortGUIDs: [{ value: "TOKEN" }] });
});

test("custom fields are well formed and match what the templates and script read", () => {
  const settings = yaml.load(settingsText);
  const byKey = Object.fromEntries(settings.custom_fields.map((f) => [f.keyname, f]));
  for (const f of settings.custom_fields) {
    assert.ok(f.keyname && f.field_type && f.name, `field missing keyname/field_type/name: ${JSON.stringify(f)}`);
  }
  for (const key of ["album_url", "fit", "show_caption", "include_videos", "salt"]) {
    assert.ok(key in byKey, `missing custom field ${key}`);
  }
  assert.equal(byKey.album_url.field_type, "url");
  assert.deepEqual(byKey.fit.options, [{ "Fill the screen (crops the edges)": "cover" }, { "Show the whole photo (adds bars)": "contain" }]);
  assert.equal(byKey.fit.default, "cover");
  assert.equal(typeof byKey.show_caption.default, "string", "boolean defaults must be quoted strings");
});

test("the plugin folder holds exactly the files TRMNL's import expects", () => {
  const files = readdirSync(pluginSrc).sort();
  assert.deepEqual(files, [
    "full.liquid",
    "half_horizontal.liquid",
    "half_vertical.liquid",
    "quadrant.liquid",
    "settings.yml",
    "shared.liquid",
    "transform.js",
  ]);
});
