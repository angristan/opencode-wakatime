#!/usr/bin/env node

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(homedir(), ".config", "opencode", "plugin");
const source = join(__dirname, "..", "dist", "bundle.js");
const target = join(pluginDir, "wakatime.js");
const packageJson = join(__dirname, "..", "package.json");

async function getVersion() {
  const pkg = JSON.parse(await readFile(packageJson, "utf-8"));
  return pkg.version;
}

async function install() {
  const version = await getVersion();
  console.log(`Installing opencode-wakatime v${version}...\n`);

  if (!existsSync(source)) {
    console.error(`Error: Built plugin not found at ${source}`);
    console.error("Run 'npm run build' first if installing from source.");
    process.exit(1);
  }

  await mkdir(pluginDir, { recursive: true });
  await copyFile(source, target);
  console.log(`Installed: ${target}`);

  console.log("\nInstallation complete!");
  console.log("\nNext steps:");
  console.log("1. Add your WakaTime API key to ~/.wakatime.cfg:");
  console.log("   [settings]");
  console.log("   api_key = your-api-key-here");
  console.log(
    "\n2. Get your API key at: https://wakatime.com/settings/api-key",
  );
}

async function uninstall() {
  console.log("Uninstalling opencode-wakatime...\n");

  if (!existsSync(target)) {
    console.log("Plugin not found, nothing to uninstall.");
    return;
  }

  const { unlink } = await import("node:fs/promises");
  await unlink(target);
  console.log(`Removed: ${target}`);
  console.log("\nUninstall complete!");
  console.log(
    "\nTo fully remove, also run: npm uninstall -g opencode-wakatime",
  );
}

function showHelp(version) {
  console.log(`opencode-wakatime v${version}

Usage: opencode-wakatime [options]

Options:
  --install    Install/update the plugin to ~/.config/opencode/plugin/
  --uninstall  Remove the plugin
  --help, -h   Show this help message

Examples:
  npm i -g opencode-wakatime && opencode-wakatime --install
`);
}

async function main() {
  const version = await getVersion();
  const arg = process.argv[2];

  switch (arg) {
    case "--install":
      await install();
      break;
    case "--uninstall":
      await uninstall();
      break;
    case "--help":
    case "-h":
    case undefined:
      showHelp(version);
      break;
    default:
      console.error(`Unknown option: ${arg}\n`);
      showHelp(version);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
