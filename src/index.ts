import * as path from "node:path";
import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { logger } from "./logger.js";
import { shouldSendHeartbeat, updateLastHeartbeat } from "./state.js";
import { ensureCliInstalled, sendHeartbeat } from "./wakatime.js";

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
    case "grep": {
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
 * Process and send heartbeats for tracked file changes
 */
function processHeartbeat(projectFolder: string, force: boolean = false): void {
  if (!shouldSendHeartbeat(force) && !force) {
    logger.debug("Skipping heartbeat (rate limited)");
    return;
  }

  if (fileChanges.size === 0) {
    logger.debug("No file changes to report");
    return;
  }

  // Send heartbeat for each file that was modified
  for (const [file, info] of fileChanges.entries()) {
    const lineChanges = info.additions - info.deletions;
    sendHeartbeat({
      entity: file,
      projectFolder,
      lineChanges,
      category: "ai coding",
      isWrite: info.isWrite,
    });
    logger.debug(
      `Sent heartbeat for ${file}: +${info.additions}/-${info.deletions} lines`,
    );
  }

  // Clear tracked changes and update state
  fileChanges.clear();
  updateLastHeartbeat();
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
  const { project, worktree } = ctx;

  // Derive project name from worktree path
  const projectName = path.basename(worktree || project.worktree);

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

  // Determine project folder
  const projectFolder = worktree || process.cwd();

  const hooks: Hooks = {
    // Track tool executions that modify files
    "tool.execute.after": async (input, output) => {
      const { tool } = input;
      const { metadata, title } = output;

      logger.debug(`Tool executed: ${tool} - ${title}`);

      // Extract file changes from tool metadata
      const changes = extractFileChanges(
        tool,
        metadata as Record<string, unknown>,
        output.output,
        title,
      );

      for (const change of changes) {
        trackFileChange(change.file, change.info);
        logger.debug(
          `Tracked: ${change.file} (+${change.info.additions ?? 0}/-${change.info.deletions ?? 0})`,
        );
      }

      // Try to send heartbeat (will be rate-limited)
      if (changes.length > 0) {
        processHeartbeat(projectFolder);
      }
    },

    // Track chat activity
    "chat.message": async (_input, _output) => {
      logger.debug("Chat message received");

      // If we have pending file changes, try to send heartbeat
      if (fileChanges.size > 0) {
        processHeartbeat(projectFolder);
      }
    },

    // Listen to all events for session lifecycle
    event: async ({ event }) => {
      // Send final heartbeat on session completion or idle
      if (event.type === "session.deleted" || event.type === "session.idle") {
        logger.debug(`Session event: ${event.type} - sending final heartbeat`);
        processHeartbeat(projectFolder, true); // Force send
      }
    },
  };

  return hooks;
};

export default plugin;
