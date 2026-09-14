/**
 * Builds plugin/src/transform.js, the self-contained script that runs inside
 * TRMNL's Serverless runtime, from the same source files the Cloudflare
 * Worker uses. Run with `npm run build:serverless` (also runs before `npm test`).
 *
 * The runtime evaluates one plain Node 20 script with no module system, so
 * relative `import` lines and `export` keywords are stripped and the files are
 * concatenated in dependency order, followed by the serverless entry point.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = (name) => resolve(here, "..", "src", name);
const out = resolve(here, "..", "..", "plugin", "src", "transform.js");

export const BUNDLE_ORDER = ["icloud.js", "pick.js", "select.js", "serverless-entry.js"];

export function stripModuleSyntax(code, name) {
  const withoutImports = code.replace(/^import\s+\{[^}]*\}\s+from\s+"\.\/[^"]+";\s*$/gm, "");
  if (/^\s*import\s/m.test(withoutImports)) {
    throw new Error(`${name} imports something other than a sibling module; the serverless bundle must be dependency-free.`);
  }
  return withoutImports.replace(/^export\s+(?=(async\s+)?function|class|const|let|var)/gm, "");
}

export function buildBundle() {
  const parts = BUNDLE_ORDER.map((name) => {
    const code = readFileSync(src(name), "utf8");
    return `// ---- ${name} ${"-".repeat(Math.max(4, 70 - name.length))}\n${stripModuleSyntax(code, name)}`;
  });
  const banner = `/**
 * TRMNL Apple Photos, Serverless edition.
 *
 * GENERATED FILE. Do not edit by hand: change worker/src/*.js and run
 * \`npm run build:serverless\` in worker/.
 *
 * Paste this whole file into the plugin's Serverless editor (language: Node),
 * or keep it as plugin/src/transform.js for \`trmnlp push\`.
 */
`;
  return banner + "\n" + parts.join("\n\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(out, buildBundle());
  console.log(`wrote ${out}`);
}
