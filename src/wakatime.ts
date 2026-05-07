import { type ChildProcess, spawn } from "node:child_process";
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

// Default timeout for heartbeat processes (30 seconds)
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;

// Track active heartbeat processes for cleanup
const activeProcesses: Set<ChildProcess> = new Set();

export interface HeartbeatParams {
  entity: string;
  projectFolder?: string;
  lineChanges?: number;
  category?: string;
  isWrite?: boolean;
  opencodeVersion?: string;
  opencodeClient?: string;
}

export function isWindows(): boolean {
  return os.platform() === "win32";
}

export function buildExecOptions(): {
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  stdio: "ignore";
  windowsHide: boolean;
} {
  const options: {
    env?: NodeJS.ProcessEnv;
    detached?: boolean;
    stdio: "ignore";
    windowsHide: boolean;
  } = {
    stdio: "ignore",
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
 *
 * Uses spawn with stdio: 'ignore' and detached: true to avoid pipe buffer
 * issues that can cause child processes to hang indefinitely.
 *
 * A timeout is set as a safety net — if the process exceeds the timeout,
 * it will be killed to prevent resource leaks.
 *
 * @param params - Heartbeat parameters
 * @param timeoutMs - Timeout in milliseconds (default: 30000)
 */
export function sendHeartbeat(
  params: HeartbeatParams,
  timeoutMs: number = DEFAULT_HEARTBEAT_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve) => {
    const cliLocation = dependencies.getCliLocation();

    if (!dependencies.isCliInstalled()) {
      logger.warn("wakatime-cli not installed, skipping heartbeat");
      resolve();
      return;
    }

    const client = params.opencodeClient || "cli";
    const opencodeVersion = params.opencodeVersion || "unknown";

    const args: string[] = [
      "--entity",
      params.entity,
      "--entity-type",
      "file",
      "--category",
      params.category ?? "ai coding",
      "--plugin",
      `opencode-${client}/${opencodeVersion} opencode-wakatime/${VERSION}`,
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
    const child = spawn(cliLocation, args, execOptions);

    // Track the process for cleanup
    activeProcesses.add(child);

    let resolved = false;
    const resolveOnce = () => {
      if (!resolved) {
        resolved = true;
        activeProcesses.delete(child);
        clearTimeout(timeoutId);
        resolve();
      }
    };

    // Safety timeout — kill the process if it hangs
    const timeoutId = setTimeout(() => {
      logger.warn(
        `Heartbeat timed out after ${timeoutMs}ms for ${params.entity}, killing process`,
      );
      try {
        child.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
      resolveOnce();
    }, timeoutMs);

    child.on("error", (error) => {
      logger.error(`wakatime-cli spawn error: ${error.message}`);
      resolveOnce();
    });

    child.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        logger.warn(`wakatime-cli exited with code ${code}`);
      } else if (signal) {
        logger.debug(`wakatime-cli terminated by signal ${signal}`);
      }
      resolveOnce();
    });
  });
}

/**
 * Kill all active heartbeat processes.
 * Call this during plugin shutdown to clean up any lingering processes.
 */
export function cleanupHeartbeats(): void {
  let killedCount = 0;
  activeProcesses.forEach((child) => {
    try {
      if (!child.killed) {
        child.kill("SIGTERM");
        killedCount++;
      }
    } catch {
      // Process may have already exited
    }
    activeProcesses.delete(child);
  });
  if (killedCount > 0) {
    logger.info(`Cleaned up ${killedCount} active heartbeat processes`);
  }
}

export function isCliAvailable(): boolean {
  return (
    dependencies.isCliInstalled() ||
    dependencies.getCliLocationGlobal() !== undefined
  );
}
