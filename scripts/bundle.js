#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["@opencode-ai/plugin"],
  outfile: "dist/bundle.js",
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});

console.log(`Bundled opencode-wakatime v${pkg.version}`);
