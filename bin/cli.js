#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { configure } from "./config.js";

async function getVersion() {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf-8"),
  );
  return pkg.version;
}

async function update(action) {
  const { updated, removed } = await configure(action);
  for (const file of updated) console.log(`Updated: ${file}`);
  for (const file of removed) console.log(`Removed legacy bundle: ${file}`);

  if (action === "install") {
    console.log("\nopencode-wakatime is registered for OpenCode v1 and v2.");
    console.log("Restart OpenCode to load the package from npm.");
    console.log(
      "\nAdd your WakaTime API key to ~/.wakatime.cfg (or $WAKATIME_HOME/.wakatime.cfg):",
    );
    console.log("   [settings]");
    console.log("   api_key = your-api-key-here");
    console.log("\nGet your API key at: https://wakatime.com/settings/api-key");
  } else {
    console.log(
      "\nRemoved opencode-wakatime from global config. Project configs are unchanged.",
    );
    console.log(
      "To remove the installer too, run: npm uninstall -g opencode-wakatime",
    );
  }
}

function showHelp(version) {
  console.log(`opencode-wakatime v${version}

Usage: opencode-wakatime [options]

Options:
  --install    Register the npm package for OpenCode v1 and v2
  --uninstall  Remove global registrations and old standalone bundles
  --help, -h   Show this help message

Config: $XDG_CONFIG_HOME/opencode/ or ~/.config/opencode/
Existing JSON/JSONC comments, settings, and version pins are preserved.

Example:
  npm i -g opencode-wakatime && opencode-wakatime --install
`);
}

async function main() {
  const version = await getVersion();
  const args = process.argv.slice(2);
  if (args.length > 1)
    throw new Error("Specify one command. Use --help for usage.");
  switch (args[0]) {
    case "--install":
      await update("install");
      break;
    case "--uninstall":
      await update("uninstall");
      break;
    case "--help":
    case "-h":
    case undefined:
      showHelp(version);
      break;
    default:
      throw new Error(`Unknown option: ${args[0]}. Use --help for usage.`);
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exitCode = 1;
});
