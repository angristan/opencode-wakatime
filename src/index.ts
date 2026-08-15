import * as fs from "node:fs";
import * as path from "node:path";
import { Plugin } from "@opencode-ai/plugin";
import { LogLevel, logger } from "./logger.js";
import {
  initState,
  shouldSendHeartbeat,
  updateLastHeartbeat,
} from "./state.js";
import {
  ensureCliInstalled,
  flushHeartbeats,
  type HeartbeatParams,
  sendHeartbeats,
} from "./wakatime.js";
import { getWakatimeConfigFilePath } from "./wakatime-paths.js";

// Set of processed tool call IDs to avoid duplicate processing
const processedCallIds = new Set<string>();

/**
 * Represents tracked changes for a single file
 */
export interface FileChangeInfo {
  additions: number;
  deletions: number;
  lastModified: number;
  isWrite: boolean; // true if file was created/overwritten
}

// Track file changes within the current session
const fileChanges = new Map<string, FileChangeInfo>();

/**
 * FileDiff structure returned by the OpenCode V2 edit/patch tools.
 * Both the tool output and result metadata expose an array of these.
 */
interface FileDiff {
  file: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}

/**
 * Extract file change information from an executed V2 tool result.
 *
 * In OpenCode V2, file-modifying tools expose a `files` array of `FileDiff`
 * objects through either the tool output or the result metadata:
 *
 * - `edit` / `patch` -> `files: [{ file, additions, deletions, status }]`
 * - `write` -> `output: { operation, target, resource, existed }`
 *
 * Search and shell tools do not carry reliable file-change information and are
 * skipped to avoid false positives.
 */
export function extractFileChanges(
  tool: string,
  output: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): Array<{ file: string; info: Partial<FileChangeInfo> }> {
  const changes: Array<{ file: string; info: Partial<FileChangeInfo> }> = [];

  const files = extractFiles(output);
  const metadataFiles = extractFiles(metadata);

  const allFiles = files.length > 0 ? files : metadataFiles;

  if (allFiles.length > 0) {
    for (const diff of allFiles) {
      if (!diff.file) continue;
      changes.push({
        file: diff.file,
        info: {
          additions: diff.additions ?? 0,
          deletions: diff.deletions ?? 0,
          isWrite: diff.status === "added",
        },
      });
    }
    return changes;
  }

  // `write` returns its target file in the tool output rather than a `files` array.
  if (tool === "write" && output) {
    const resource =
      (output.resource as string | undefined) ??
      (output.target as string | undefined);
    const existed = output.existed as boolean | undefined;
    if (resource) {
      changes.push({
        file: resource,
        info: {
          additions: 0,
          deletions: 0,
          isWrite: !existed,
        },
      });
    }
  }

  return changes;
}

/**
 * Pull a `FileDiff[]` from either the `files` field of a tool output or the
 * `files` field of the result metadata.
 */
function extractFiles(source: Record<string, unknown> | undefined): FileDiff[] {
  if (!source) return [];
  const files = source.files;
  if (!Array.isArray(files)) return [];
  return files.filter(
    (item): item is FileDiff =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as FileDiff).file === "string",
  );
}

/**
 * Process and send heartbeats for tracked file changes.
 * When force is true, awaits all heartbeats to ensure they complete before shutdown.
 */
async function processHeartbeat(
  projectFolder: string,
  opencodeVersion: string,
  opencodeClient: string,
  force: boolean = false,
): Promise<void> {
  if (!shouldSendHeartbeat(force) && !force) {
    logger.debug("Skipping heartbeat (rate limited)");
    return;
  }

  if (fileChanges.size === 0) {
    logger.debug("No file changes to report");
    if (force) {
      await flushHeartbeats();
    }
    return;
  }

  const heartbeats: HeartbeatParams[] = [];

  // Send heartbeat for each file that was modified
  for (const [file, info] of fileChanges.entries()) {
    const lineChanges = info.additions - info.deletions;
    heartbeats.push({
      entity: file,
      projectFolder,
      lineChanges,
      category: "ai coding",
      isWrite: info.isWrite,
      opencodeVersion,
      opencodeClient,
    });

    logger.debug(
      `Sent heartbeat for ${file}: +${info.additions}/-${info.deletions} lines`,
    );
  }

  // Clear tracked changes and update state
  fileChanges.clear();
  updateLastHeartbeat();

  void sendHeartbeats(heartbeats);

  // On session completion, wait for both this batch and any previous batch.
  if (force) {
    logger.debug(`Waiting for ${heartbeats.length} heartbeats to complete...`);
    await flushHeartbeats();
    logger.debug("All heartbeat batches completed");
  }
}

/**
 * Update tracked file changes
 */
function trackFileChange(file: string, info: Partial<FileChangeInfo>): void {
  const existing = fileChanges.get(file) ?? {
    additions: 0,
    deletions: 0,
    lastModified: Date.now(),
    isWrite: false,
  };

  fileChanges.set(file, {
    additions: existing.additions + (info.additions ?? 0),
    deletions: existing.deletions + (info.deletions ?? 0),
    lastModified: Date.now(),
    isWrite: existing.isWrite || (info.isWrite ?? false),
  });
}

export function resolveProjectFolder(cwd: string = process.cwd()): string {
  return cwd;
}

export default Plugin.define({
  id: "opencode-wakatime",
  setup: async (ctx) => {
    // Read debug setting from ~/.wakatime.cfg (or $WAKATIME_HOME/.wakatime.cfg)
    const wakatimeCfgPath = getWakatimeConfigFilePath();
    try {
      const cfg = fs.readFileSync(wakatimeCfgPath, "utf-8");
      const debugMatch = cfg.match(/^\s*debug\s*=\s*true\s*$/m);
      if (debugMatch) {
        logger.setLevel(LogLevel.DEBUG);
      }
    } catch {
      // Config file doesn't exist or can't be read, keep default INFO level
    }

    // The V2 plugin context exposes the running OpenCode app identity. The
    // background server may run with `/` as its cwd, so use the process cwd
    // as the project folder fallback (GUI/server clients may differ).
    const projectFolder = resolveProjectFolder();
    const projectName = path.basename(projectFolder);

    // Detect opencode client type (cli, desktop, app) from the app identity.
    // Map "app" to "web" for a clearer plugin identifier.
    const rawClient = ctx.app.name || process.env.OPENCODE_CLIENT || "cli";
    const opencodeClient = rawClient === "app" ? "web" : rawClient;
    const opencodeVersion = ctx.app.version || "unknown";

    logger.debug(
      `OpenCode client: ${opencodeClient}, version: ${opencodeVersion}`,
    );

    // Initialize project-specific state for rate limiting
    initState(projectFolder);

    // Ensure wakatime-cli is installed (will auto-download if needed)
    const cliInstalled = await ensureCliInstalled();

    if (!cliInstalled) {
      logger.warn(
        "WakaTime CLI could not be installed. Please install it manually: https://wakatime.com/terminal",
      );
    } else {
      logger.info(
        `OpenCode WakaTime plugin initialized for project: ${projectName}`,
      );
    }

    // Track completed tool executions via the tool hook. This replaces the
    // V1 `message.part.updated` event parsing and covers both regular tool
    // calls and batch tool executions.
    await ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return;

      const { tool } = event;
      const result = event.result;
      const output =
        result.output && typeof result.output === "object"
          ? (result.output as Record<string, unknown>)
          : undefined;
      const metadata =
        result.metadata && typeof result.metadata === "object"
          ? (result.metadata as Record<string, unknown>)
          : undefined;

      // Avoid duplicate processing (tools can emit multiple updates)
      if (processedCallIds.has(event.id)) return;
      processedCallIds.add(event.id);

      // Clean up old callIds periodically (keep last 1000)
      if (processedCallIds.size > 1000) {
        const idsArray = Array.from(processedCallIds);
        for (let i = 0; i < 500; i++) {
          const staleId = idsArray[i];
          if (staleId !== undefined) processedCallIds.delete(staleId);
        }
      }

      const changes = extractFileChanges(tool, output, metadata);

      for (const change of changes) {
        // Skip directories — they end up as "Other" in WakaTime
        try {
          if (fs.statSync(change.file).isDirectory()) {
            logger.debug(`Skipping directory: ${change.file}`);
            continue;
          }
        } catch {
          // File may not exist (deleted/temp) — still track it
        }

        trackFileChange(change.file, change.info);
        logger.debug(
          `Tracked: ${change.file} (+${change.info.additions ?? 0}/-${change.info.deletions ?? 0})`,
        );
      }

      // Try to send heartbeat (will be rate-limited)
      if (changes.length > 0) {
        void processHeartbeat(projectFolder, opencodeVersion, opencodeClient);
      }
    });

    // Send a final heartbeat when a session is deleted or goes idle.
    const eventStream = ctx.event.subscribe();
    const iterator = eventStream[Symbol.asyncIterator]();
    let stopped = false;

    const _heartbeatLoop = (async () => {
      try {
        for (;;) {
          const { done, value: event } = await iterator.next();
          if (done) return;
          if (
            event.type === "session.deleted" ||
            event.type === "session.idle"
          ) {
            logger.debug(
              `Session event: ${event.type} - sending final heartbeat`,
            );
            await processHeartbeat(
              projectFolder,
              opencodeVersion,
              opencodeClient,
              true,
            );
          }
        }
      } finally {
        if (!stopped) {
          stopped = true;
          await iterator.return?.();
        }
      }
    })();

    return () => {
      // On cleanup, stop the event loop and flush any in-flight heartbeats.
      stopped = true;
      void iterator.return?.();
      void flushHeartbeats();
    };
  },
});
