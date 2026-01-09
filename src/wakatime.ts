import { type ExecFileOptions, execFile } from "node:child_process";
import * as os from "node:os";
import { dependencies } from "./dependencies.js";
import { logger } from "./logger.js";

// Version is inlined at build time by esbuild
// Falls back to package.json version for development
declare const __VERSION__: string | undefined;

function getVersion(): string {
  // Check for build-time injected version first
  if (typeof __VERSION__ !== "undefined") {
    return __VERSION__;
  }

  // Fallback for development: try to read from package.json
  try {
    // Dynamic import to avoid bundling issues
    const fs = require("node:fs");
    const path = require("node:path");
    const { fileURLToPath } = require("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
    );
    return pkg.version;
  } catch {
    return "unknown";
  }
}

const VERSION = getVersion();

export interface HeartbeatParams {
  entity: string;
  projectFolder?: string;
  lineChanges?: number;
  category?: string;
  isWrite?: boolean;
}

export function isWindows(): boolean {
  return os.platform() === "win32";
}

export function buildExecOptions(): ExecFileOptions {
  const options: ExecFileOptions = {
    windowsHide: true,
  };

  if (!isWindows() && !process.env.WAKATIME_HOME && !process.env.HOME) {
    options.env = { ...process.env, WAKATIME_HOME: os.homedir() };
  }

  return options;
}

export function formatArgs(args: string[]): string {
  return args
    .map((arg) => {
      if (arg.includes(" ")) {
        return `"${arg.replace(/"/g, '\\"')}"`;
      }
      return arg;
    })
    .join(" ");
}

export async function ensureCliInstalled(): Promise<boolean> {
  try {
    await dependencies.checkAndInstallCli();
    return dependencies.isCliInstalled();
  } catch (err) {
    logger.errorException(err);
    return false;
  }
}

/**
 * Send a heartbeat to WakaTime.
 * Returns a Promise that resolves when the heartbeat is sent.
 */
export function sendHeartbeat(params: HeartbeatParams): Promise<void> {
  return new Promise((resolve) => {
    const cliLocation = dependencies.getCliLocation();

    if (!dependencies.isCliInstalled()) {
      logger.warn("wakatime-cli not installed, skipping heartbeat");
      resolve();
      return;
    }

    const args: string[] = [
      "--entity",
      params.entity,
      "--entity-type",
      "file",
      "--category",
      params.category ?? "ai coding",
      "--plugin",
      `opencode/1.0.0 opencode-wakatime/${VERSION}`,
    ];

    if (params.projectFolder) {
      args.push("--project-folder", params.projectFolder);
    }

    if (params.lineChanges !== undefined && params.lineChanges !== 0) {
      args.push("--ai-line-changes", params.lineChanges.toString());
    }

    if (params.isWrite) {
      args.push("--write");
    }

    logger.debug(`Sending heartbeat: wakatime-cli ${formatArgs(args)}`);

    const execOptions = buildExecOptions();
    execFile(cliLocation, args, execOptions, (error, stdout, stderr) => {
      const output =
        (stdout?.toString().trim() ?? "") + (stderr?.toString().trim() ?? "");
      if (output) {
        logger.debug(`wakatime-cli output: ${output}`);
      }
      if (error) {
        logger.error(`wakatime-cli error: ${error.message}`);
      }
      // Always resolve - we don't want heartbeat failures to break the plugin
      resolve();
    });
  });
}

export function isCliAvailable(): boolean {
  return (
    dependencies.isCliInstalled() ||
    dependencies.getCliLocationGlobal() !== undefined
  );
}
