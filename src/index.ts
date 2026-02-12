import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { LogLevel, logger } from "./logger.js";
import {
  initState,
  shouldSendHeartbeat,
  updateLastHeartbeat,
} from "./state.js";
import { ensureCliInstalled, sendHeartbeat } from "./wakatime.js";

/**
 * Type definitions for OpenCode SDK event parts
 */
interface ToolStateCompleted {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { start: number; end: number };
}

interface ToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: { status: string } & Partial<ToolStateCompleted>;
}

interface MessagePartUpdatedEvent {
  type: "message.part.updated";
  properties: {
    part: ToolPart | { type: string };
  };
}

/**
 * Type guard to check if an event is a MessagePartUpdatedEvent
 */
function isMessagePartUpdatedEvent(event: {
  type: string;
}): event is MessagePartUpdatedEvent {
  return event.type === "message.part.updated";
}

// Set of processed callIDs to avoid duplicate processing
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

// Cache opencode version - written to a file so all plugin instances can share it
const OPENCODE_VERSION_CACHE = path.join(
  os.homedir(),
  ".wakatime",
  "opencode-version-cache.json",
);

/**
 * FileDiff structure from opencode's edit tool
 */
interface FileDiff {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

/**
 * Extract file change information from tool metadata
 * Handles various tool types: edit, write, patch, multiedit, read
 */
export function extractFileChanges(
  tool: string,
  metadata: Record<string, unknown> | undefined,
  output: string,
  title?: string,
): Array<{ file: string; info: Partial<FileChangeInfo> }> {
  const changes: Array<{ file: string; info: Partial<FileChangeInfo> }> = [];

  if (!metadata) return changes;

  switch (tool) {
    case "edit": {
      // Edit tool returns filediff with detailed change info
      const filediff = metadata.filediff as FileDiff | undefined;
      if (filediff?.file) {
        changes.push({
          file: filediff.file,
          info: {
            additions: filediff.additions ?? 0,
            deletions: filediff.deletions ?? 0,
            isWrite: false,
          },
        });
      } else {
        // Fallback to filePath from metadata
        const filePath = metadata.filePath as string | undefined;
        if (filePath) {
          changes.push({
            file: filePath,
            info: { additions: 0, deletions: 0, isWrite: false },
          });
        }
      }
      break;
    }

    case "write": {
      // Write tool creates or overwrites files
      const filepath = metadata.filepath as string | undefined;
      const exists = metadata.exists as boolean | undefined;
      if (filepath) {
        changes.push({
          file: filepath,
          info: {
            additions: 0,
            deletions: 0,
            isWrite: !exists, // New file creation
          },
        });
      }
      break;
    }

    case "patch": {
      // Patch tool returns diff count and lists files in output
      // Output format: "Patch applied successfully. N files changed:\n  file1\n  file2"
      const diff = metadata.diff as number | undefined;
      const lines = output.split("\n");
      const files: string[] = [];

      for (const line of lines) {
        // Files are listed with 2-space indent
        if (line.startsWith("  ") && !line.startsWith("   ")) {
          const file = line.trim();
          if (file && !file.includes(" ")) {
            files.push(file);
          }
        }
      }

      // Distribute diff evenly across files (approximation)
      const perFileDiff =
        files.length > 0 ? Math.round((diff ?? 0) / files.length) : 0;
      for (const file of files) {
        changes.push({
          file,
          info: {
            additions: perFileDiff > 0 ? perFileDiff : 0,
            deletions: perFileDiff < 0 ? Math.abs(perFileDiff) : 0,
            isWrite: false,
          },
        });
      }
      break;
    }

    case "multiedit": {
      // Multiedit returns array of edit results, each containing filediff
      const results = metadata.results as
        | Array<{ filediff?: FileDiff }>
        | undefined;
      if (results) {
        for (const result of results) {
          if (result.filediff?.file) {
            changes.push({
              file: result.filediff.file,
              info: {
                additions: result.filediff.additions ?? 0,
                deletions: result.filediff.deletions ?? 0,
                isWrite: false,
              },
            });
          }
        }
      }
      break;
    }

    case "read": {
      // Read tool - title contains the file path
      if (title) {
        changes.push({
          file: title,
          info: { additions: 0, deletions: 0, isWrite: false },
        });
      }
      break;
    }

    case "glob":
    case "grep":
    case "codesearch": {
      // Search tools - might indicate files being worked on
      // Don't track these as they don't modify files
      break;
    }

    case "bash": {
      // Bash commands might modify files, but we can't easily track which ones
      // Skip for now to avoid false positives
      break;
    }
  }

  return changes;
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
    return;
  }

  // Collect all heartbeat promises
  const heartbeatPromises: Promise<void>[] = [];

  // Send heartbeat for each file that was modified
  for (const [file, info] of fileChanges.entries()) {
    const lineChanges = info.additions - info.deletions;
    const promise = sendHeartbeat({
      entity: file,
      projectFolder,
      lineChanges,
      category: "ai coding",
      isWrite: info.isWrite,
      opencodeVersion,
      opencodeClient,
    });

    if (force) {
      // When forcing (shutdown), collect promises to await
      heartbeatPromises.push(promise);
    }

    logger.debug(
      `Sent heartbeat for ${file}: +${info.additions}/-${info.deletions} lines`,
    );
  }

  // Clear tracked changes and update state
  fileChanges.clear();
  updateLastHeartbeat();

  // On shutdown, wait for all heartbeats to complete
  if (force && heartbeatPromises.length > 0) {
    logger.debug(
      `Waiting for ${heartbeatPromises.length} heartbeats to complete...`,
    );
    await Promise.all(heartbeatPromises);
    logger.debug("All heartbeats completed");
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

export const plugin: Plugin = async (ctx) => {
  // Read debug setting from ~/.wakatime.cfg [settings] section
  const wakatimeCfgPath = path.join(os.homedir(), ".wakatime.cfg");
  try {
    const cfg = fs.readFileSync(wakatimeCfgPath, "utf-8");
    const debugMatch = cfg.match(/^\s*debug\s*=\s*true\s*$/m);
    if (debugMatch) {
      logger.setLevel(LogLevel.DEBUG);
    }
  } catch {
    // Config file doesn't exist or can't be read, keep default INFO level
  }

  const { project, worktree, client } = ctx;

  // Derive project name from worktree path
  const projectName = path.basename(worktree || project.worktree);

  // Determine project folder
  const projectFolder = worktree || process.cwd();

  // Detect opencode client type (cli, desktop, app) from environment
  // Map "app" to "web" for a clearer plugin identifier
  const rawClient = process.env.OPENCODE_CLIENT || "cli";
  const opencodeClient = rawClient === "app" ? "web" : rawClient;

  // Fetch opencode version from the server health endpoint
  // Use the SDK client's internal HTTP client which bypasses server auth
  // Cache to a file since the plugin is loaded as separate module instances
  let opencodeVersion = "unknown";
  try {
    // Check file cache first (written by whichever instance succeeds first)
    const cached = JSON.parse(fs.readFileSync(OPENCODE_VERSION_CACHE, "utf-8"));
    // Cache is valid for 60 seconds
    if (cached.version && Date.now() - cached.timestamp < 60_000) {
      opencodeVersion = cached.version;
    }
  } catch {
    // No cache or invalid — fetch from server
  }
  if (opencodeVersion === "unknown") {
    try {
      const httpClient =
        (client as any).global._client ?? (client as any)._client;
      const { data } = await httpClient.get({ url: "/global/health" });
      if (data?.version) {
        opencodeVersion = data.version;
        try {
          fs.writeFileSync(
            OPENCODE_VERSION_CACHE,
            JSON.stringify({ version: data.version, timestamp: Date.now() }),
          );
        } catch {
          // Ignore write errors
        }
      }
    } catch (err) {
      logger.warn(`Could not fetch OpenCode version: ${err}`);
    }
  }

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

  const hooks: Hooks = {
    // Track chat activity
    "chat.message": async (_input, _output) => {
      logger.debug("Chat message received");

      // If we have pending file changes, try to send heartbeat
      if (fileChanges.size > 0) {
        await processHeartbeat(projectFolder, opencodeVersion, opencodeClient);
      }
    },

    // Listen to all events for tool execution and session lifecycle
    // Using message.part.updated captures both regular tool calls AND
    // tools executed via the batch tool
    event: async ({ event }) => {
      // Track completed tool executions via message.part.updated
      if (isMessagePartUpdatedEvent(event)) {
        const { part } = event.properties;

        // Only process tool parts
        if (part.type !== "tool") return;

        const toolPart = part as ToolPart;

        // Only process completed tools
        if (toolPart.state.status !== "completed") return;

        // Avoid duplicate processing (tools can emit multiple updates)
        if (processedCallIds.has(toolPart.callID)) return;
        processedCallIds.add(toolPart.callID);

        // Clean up old callIds periodically (keep last 1000)
        if (processedCallIds.size > 1000) {
          const idsArray = Array.from(processedCallIds);
          for (let i = 0; i < 500; i++) {
            processedCallIds.delete(idsArray[i]);
          }
        }

        const { tool } = toolPart;
        const state = toolPart.state as ToolStateCompleted;
        const { metadata, title, output } = state;

        logger.debug(`Tool executed: ${tool} - ${title}`);

        // Extract file changes from tool metadata
        const changes = extractFileChanges(
          tool,
          metadata as Record<string, unknown>,
          output,
          title,
        );

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
          await processHeartbeat(
            projectFolder,
            opencodeVersion,
            opencodeClient,
          );
        }
      }

      // Send final heartbeat on session completion or idle
      if (event.type === "session.deleted" || event.type === "session.idle") {
        logger.debug(`Session event: ${event.type} - sending final heartbeat`);
        await processHeartbeat(
          projectFolder,
          opencodeVersion,
          opencodeClient,
          true,
        ); // Force send and await
      }
    },
  };

  return hooks;
};

export default plugin;
