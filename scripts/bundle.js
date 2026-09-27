#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);

const options = {
  bundle: true,
  platform: "node",
  format: "esm",
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
};

await build({
  ...options,
  entryPoints: ["src/index.ts", "src/server.ts"],
  outdir: "dist",
  splitting: true,
});

for (const [entry, outfile] of [
  ["src/index.ts", "dist/bundle.js"],
  ["src/server.ts", "dist/bundle-v2.js"],
]) {
  await build({ ...options, entryPoints: [entry], outfile });
}

console.log(`Bundled opencode-wakatime v${pkg.version}`);
