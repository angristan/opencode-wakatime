import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from "node:child_process";
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
const HEARTBEAT_KILL_GRACE_MS = 2_000;

const pendingHeartbeatBatches = new Set<Promise<void>>();
const activeHeartbeatProcesses = new Set<ChildProcess>();

/**
 * Process exit handlers cannot wait for pending promises. Force-kill any
 * remaining CLI children so one-shot OpenCode commands cannot orphan them.
 */
export function killActiveHeartbeats(): void {
  for (const child of activeHeartbeatProcesses) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the status check and the signal.
    }
  }
}

process.once("exit", killActiveHeartbeats);

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

export function buildExecOptions(): SpawnOptions {
  const options: SpawnOptions = {
    stdio: ["pipe", "ignore", "ignore"],
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
 * Send heartbeats to WakaTime in a single CLI invocation.
 *
 * The first heartbeat is passed through regular CLI arguments. Additional
 * heartbeats use wakatime-cli's --extra-heartbeats JSON input on stdin, which
 * avoids creating one process per changed file during batch edits.
 *
 * @param params - Heartbeat parameters to send as one batch
 * @param timeoutMs - Timeout in milliseconds (default: 30000)
 */
export function sendHeartbeats(
  params: HeartbeatParams[],
  timeoutMs: number = DEFAULT_HEARTBEAT_TIMEOUT_MS,
): Promise<void> {
  const heartbeatBatch = new Promise<void>((resolve) => {
    if (params.length === 0) {
      resolve();
      return;
    }

    const cliLocation = dependencies.getCliLocation();

    if (!dependencies.isCliInstalled()) {
      logger.warn("wakatime-cli not installed, skipping heartbeat");
      resolve();
      return;
    }

    const [primary, ...extra] = params;
    const client = primary.opencodeClient || "cli";
    const opencodeVersion = primary.opencodeVersion || "unknown";

    const args: string[] = [
      "--entity",
      primary.entity,
      "--entity-type",
      "file",
      "--category",
      primary.category ?? "ai coding",
      "--plugin",
      `opencode-${client}/${opencodeVersion} opencode-wakatime/${VERSION}`,
    ];

    if (primary.projectFolder) {
      args.push("--project-folder", primary.projectFolder);
    }

    if (primary.lineChanges !== undefined && primary.lineChanges !== 0) {
      args.push("--ai-line-changes", primary.lineChanges.toString());
    }

    if (primary.isWrite) {
      args.push("--write");
    }

    if (extra.length > 0) {
      args.push("--extra-heartbeats");
    }

    logger.debug(
      `Sending ${params.length} heartbeat(s): wakatime-cli ${formatArgs(args)}`,
    );

    const execOptions = buildExecOptions();
    const child = spawn(cliLocation, args, execOptions);
    activeHeartbeatProcesses.add(child);

    let resolved = false;
    let forceKillId: NodeJS.Timeout | undefined;
    const resolveOnce = () => {
      if (!resolved) {
        resolved = true;
        activeHeartbeatProcesses.delete(child);
        clearTimeout(timeoutId);
        if (forceKillId) clearTimeout(forceKillId);
        resolve();
      }
    };

    // Safety timeout — terminate the process, then force-kill if necessary.
    const timeoutId = setTimeout(() => {
      logger.warn(
        `Heartbeat batch timed out after ${timeoutMs}ms, terminating wakatime-cli`,
      );
      try {
        child.kill("SIGTERM");
      } catch (error) {
        logger.error(`Failed to terminate wakatime-cli: ${error}`);
      }

      forceKillId = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;

        logger.warn("wakatime-cli did not exit after SIGTERM, sending SIGKILL");
        try {
          child.kill("SIGKILL");
        } catch (error) {
          logger.error(`Failed to kill wakatime-cli: ${error}`);
        }
      }, HEARTBEAT_KILL_GRACE_MS);
    }, timeoutMs);

    child.once("error", (error) => {
      logger.error(`wakatime-cli spawn error: ${error.message}`);
      resolveOnce();
    });

    child.once("close", (code, signal) => {
      if (code !== null && code !== 0) {
        logger.warn(`wakatime-cli exited with code ${code}`);
      } else if (signal) {
        logger.debug(`wakatime-cli terminated by signal ${signal}`);
      }
      resolveOnce();
    });

    const timestamp = Date.now() / 1000;
    const extraHeartbeats = extra.map((heartbeat) => ({
      ai_line_changes:
        heartbeat.lineChanges !== undefined && heartbeat.lineChanges !== 0
          ? heartbeat.lineChanges
          : undefined,
      category: heartbeat.category ?? "ai coding",
      entity: heartbeat.entity,
      entity_type: "file",
      is_write: heartbeat.isWrite || undefined,
      time: timestamp,
    }));

    child.stdin?.on("error", (error) => {
      logger.error(`wakatime-cli stdin error: ${error.message}`);
    });
    child.stdin?.end(
      extraHeartbeats.length > 0
        ? `${JSON.stringify(extraHeartbeats)}\n`
        : undefined,
    );
  });

  if (params.length > 0) {
    pendingHeartbeatBatches.add(heartbeatBatch);
    void heartbeatBatch.then(
      () => pendingHeartbeatBatches.delete(heartbeatBatch),
      () => pendingHeartbeatBatches.delete(heartbeatBatch),
    );
  }

  return heartbeatBatch;
}

export function sendHeartbeat(
  params: HeartbeatParams,
  timeoutMs: number = DEFAULT_HEARTBEAT_TIMEOUT_MS,
): Promise<void> {
  return sendHeartbeats([params], timeoutMs);
}

/** Wait for every heartbeat batch that is currently in flight. */
export async function flushHeartbeats(): Promise<void> {
  while (pendingHeartbeatBatches.size > 0) {
    await Promise.all(pendingHeartbeatBatches);
  }
}

export function isCliAvailable(): boolean {
  return (
    dependencies.isCliInstalled() ||
    dependencies.getCliLocationGlobal() !== undefined
  );
}
