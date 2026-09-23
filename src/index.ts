import * as fs from "node:fs";
import * as path from "node:path";
import { LogLevel, logger } from "./logger.js";
import {
  asRecord,
  detectOpenCodeClient,
  firstString,
  normalizeToolName,
  type PluginContext,
  type PluginDefinition,
  resolveOpenCode2ProjectFolder,
  toolCallId,
} from "./opencode-v2.js";
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
  properties?: unknown;
}): event is MessagePartUpdatedEvent {
  const properties = asRecord(event.properties);
  return event.type === "message.part.updated" && !!asRecord(properties?.part);
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

// Per-project file changes. A global OpenCode 2 plugin can observe more than one project.
const changesByProject = new Map<string, Map<string, FileChangeInfo>>();

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
  tool = normalizeToolName(tool);

  if (!metadata && tool !== "read") return changes;
  const meta = metadata ?? {};

  switch (tool) {
    case "edit": {
      // Edit tool returns filediff with detailed change info
      const filediff = meta.filediff as FileDiff | undefined;
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
        const filePath = meta.filePath as string | undefined;
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
      const filepath = meta.filepath as string | undefined;
      const exists = meta.exists as boolean | undefined;
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
      const diff = meta.diff as number | undefined;
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
      const results = meta.results as
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

const INPUT_PATH_KEYS = ["filePath", "filepath", "path", "file", "file_path"];

/**
 * Normalize an OpenCode 2 `tool.execute.after` result into the same file list
 * `extractFileChanges` already understands. Falls back to tool input paths when
 * the result metadata does not include a diff.
 */
export function extractToolObservation(
  tool: string,
  input: unknown,
  result: unknown,
): Array<{ file: string; info: Partial<FileChangeInfo> }> {
  const resultRecord = asRecord(result);
  const metadata = asRecord(resultRecord?.metadata);
  const output =
    typeof resultRecord?.output === "string"
      ? resultRecord.output
      : typeof resultRecord?.content === "string"
        ? resultRecord.content
        : typeof result === "string"
          ? result
          : "";
  const title =
    typeof resultRecord?.title === "string" ? resultRecord.title : undefined;

  const fromResult = extractFileChanges(
    tool,
    metadata ??
      (resultRecord &&
      ("filediff" in resultRecord ||
        "filepath" in resultRecord ||
        "filePath" in resultRecord ||
        "results" in resultRecord ||
        "diff" in resultRecord)
        ? resultRecord
        : undefined),
    output,
    title,
  );
  if (fromResult.length > 0) return fromResult;

  const inputRecord = asRecord(input);
  const inputPath = firstString(inputRecord, INPUT_PATH_KEYS);
  if (!inputPath) return [];

  const normalized = normalizeToolName(tool);
  if (normalized === "write") {
    return extractFileChanges(
      tool,
      {
        filepath: inputPath,
        exists: inputRecord?.exists === true,
      },
      output,
      title,
    );
  }

  return extractFileChanges(
    tool,
    { filePath: inputPath },
    output,
    title ?? inputPath,
  );
}

/**
 * Process and send heartbeats for tracked file changes.
 * When force is true, awaits all heartbeats to ensure they complete before shutdown.
 */
function projectChanges(projectFolder: string): Map<string, FileChangeInfo> {
  let bucket = changesByProject.get(projectFolder);
  if (!bucket) {
    bucket = new Map();
    changesByProject.set(projectFolder, bucket);
  }
  return bucket;
}

function hasPendingChanges(): boolean {
  for (const bucket of changesByProject.values()) {
    if (bucket.size > 0) return true;
  }
  return false;
}

async function processHeartbeat(
  projectFolder: string,
  opencodeVersion: string,
  opencodeClient: string,
  force: boolean = false,
): Promise<void> {
  initState(projectFolder);
  const bucket = changesByProject.get(projectFolder);

  if (!shouldSendHeartbeat(force) && !force) {
    logger.debug("Skipping heartbeat (rate limited)");
    return;
  }

  if (!bucket || bucket.size === 0) {
    logger.debug("No file changes to report");
    if (force) {
      await flushHeartbeats();
    }
    return;
  }

  const heartbeats: HeartbeatParams[] = [];

  for (const [file, info] of bucket.entries()) {
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

  bucket.clear();
  updateLastHeartbeat();

  void sendHeartbeats(heartbeats);

  if (force) {
    logger.debug(`Waiting for ${heartbeats.length} heartbeats to complete...`);
    await flushHeartbeats();
    logger.debug("All heartbeat batches completed");
  }
}

async function flushAll(
  opencodeVersion: string,
  opencodeClient: string,
): Promise<void> {
  const folders = [...changesByProject.keys()];
  if (folders.length === 0) {
    await flushHeartbeats();
    return;
  }
  for (const folder of folders) {
    await processHeartbeat(folder, opencodeVersion, opencodeClient, true);
  }
}

function trackFileChange(
  projectFolder: string,
  file: string,
  info: Partial<FileChangeInfo>,
): void {
  const bucket = projectChanges(projectFolder);
  const existing = bucket.get(file) ?? {
    additions: 0,
    deletions: 0,
    lastModified: Date.now(),
    isWrite: false,
  };

  bucket.set(file, {
    additions: existing.additions + (info.additions ?? 0),
    deletions: existing.deletions + (info.deletions ?? 0),
    lastModified: Date.now(),
    isWrite: existing.isWrite || (info.isWrite ?? false),
  });
}

export function resolveProjectFolder(
  worktree: string | undefined,
  projectWorktree: string | undefined,
  cwd: string = process.cwd(),
): string {
  return worktree || projectWorktree || cwd;
}

function rememberCall(id: string | undefined): boolean {
  if (!id) return true;
  if (processedCallIds.has(id)) return false;
  processedCallIds.add(id);
  if (processedCallIds.size > 1000) {
    const ids = Array.from(processedCallIds);
    for (let i = 0; i < 500; i++) {
      processedCallIds.delete(ids[i]);
    }
  }
  return true;
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function trackChanges(
  projectFolder: string,
  changes: Array<{ file: string; info: Partial<FileChangeInfo> }>,
): number {
  let tracked = 0;
  for (const change of changes) {
    if (isDirectory(change.file)) {
      logger.debug(`Skipping directory: ${change.file}`);
      continue;
    }
    trackFileChange(projectFolder, change.file, change.info);
    tracked += 1;
    logger.debug(
      `Tracked: ${change.file} (+${change.info.additions ?? 0}/-${change.info.deletions ?? 0})`,
    );
  }
  return tracked;
}

function sessionIdFromEvent(properties: unknown): string | undefined {
  const props = asRecord(properties);
  const info = asRecord(props?.info);
  const part = asRecord(props?.part);
  return (
    firstString(props, ["sessionID"]) ||
    firstString(info, ["sessionID", "id"]) ||
    firstString(part, ["sessionID"])
  );
}

function isSessionFlushEvent(event: {
  type: string;
  properties?: unknown;
}): boolean {
  if (event.type === "session.deleted" || event.type === "session.idle") {
    return true;
  }
  if (event.type !== "session.status") return false;
  const props = asRecord(event.properties);
  const info = asRecord(props?.info);
  return props?.status === "idle" || info?.status === "idle";
}

async function subscribeEvents(
  ctx: PluginContext,
  signal: AbortSignal,
): Promise<AsyncIterable<{ type: string; properties?: unknown }> | undefined> {
  const subscribe = ctx.event?.subscribe;
  if (typeof subscribe !== "function") return undefined;

  const start = (options?: { signal?: AbortSignal }) => {
    try {
      return subscribe(options);
    } catch {
      return undefined;
    }
  };

  let stream = start({ signal }) ?? start();
  if (!stream) return undefined;
  if (typeof (stream as Promise<unknown>).then === "function") {
    stream = await stream;
  }
  if (
    !stream ||
    typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] !==
      "function"
  ) {
    return undefined;
  }
  return stream as AsyncIterable<{ type: string; properties?: unknown }>;
}

export const plugin: PluginDefinition = {
  id: "opencode-wakatime",
  async setup(ctx) {
    const wakatimeCfgPath = getWakatimeConfigFilePath();
    try {
      const cfg = fs.readFileSync(wakatimeCfgPath, "utf-8");
      if (/^\s*debug\s*=\s*true\s*$/m.test(cfg)) {
        logger.setLevel(LogLevel.DEBUG);
      }
    } catch {
      // Config file doesn't exist or can't be read, keep default INFO level
    }

    const fallbackFolder = resolveOpenCode2ProjectFolder({
      locationDirectory: ctx.location?.directory,
      projectDirectory: ctx.location?.project?.directory,
      projectCanonical: ctx.location?.project?.canonical,
    });
    const opencodeVersion = ctx.app?.version || "unknown";
    const opencodeClient = detectOpenCodeClient(ctx.app);
    const sessionFolders = new Map<string, string>();

    logger.debug(
      `OpenCode client: ${opencodeClient}, version: ${opencodeVersion}`,
    );

    const cliInstalled = await ensureCliInstalled();
    if (!cliInstalled) {
      logger.warn(
        "WakaTime CLI could not be installed. Please install it manually: https://wakatime.com/terminal",
      );
    } else {
      logger.info(
        `OpenCode 2 WakaTime plugin initialized for project: ${path.basename(fallbackFolder)}`,
      );
    }

    const resolveFolder = async (sessionID?: string): Promise<string> => {
      if (!sessionID) return fallbackFolder;
      const cached = sessionFolders.get(sessionID);
      if (cached) return cached;
      try {
        const info = await ctx.session?.get?.({ sessionID });
        const directory = info?.location?.directory;
        if (directory) {
          sessionFolders.set(sessionID, directory);
          return directory;
        }
      } catch {
        // Session lookup is best-effort; fall back to the plugin location.
      }
      return fallbackFolder;
    };

    const onActivity = async (sessionID?: string, force = false) => {
      const folder = await resolveFolder(sessionID);
      await processHeartbeat(folder, opencodeVersion, opencodeClient, force);
    };

    if (typeof ctx.tool?.hook === "function") {
      await ctx.tool.hook("execute.after", async (event) => {
        if (event.status && event.status !== "completed") return;
        if (!rememberCall(toolCallId(event))) return;

        const changes = extractToolObservation(
          event.tool,
          event.input,
          event.result,
        );
        logger.debug(`Tool executed: ${event.tool}`);
        if (trackChanges(await resolveFolder(event.sessionID), changes) > 0) {
          await onActivity(event.sessionID);
        }
      });
    }

    if (typeof ctx.session?.hook === "function") {
      await ctx.session.hook("prompt", async (event) => {
        logger.debug("Prompt received");
        if (hasPendingChanges()) {
          await onActivity(event.sessionID);
        }
      });
    }

    const controller = new AbortController();
    void (async () => {
      const stream = await subscribeEvents(ctx, controller.signal);
      if (!stream) return;
      for await (const event of stream) {
        if (controller.signal.aborted) break;

        if (isMessagePartUpdatedEvent(event)) {
          const part = event.properties.part;
          if (part.type !== "tool") continue;
          const toolPart = part as ToolPart;
          if (toolPart.state.status !== "completed") continue;
          if (!rememberCall(toolPart.callID)) continue;

          const state = toolPart.state as ToolStateCompleted;
          const changes = extractFileChanges(
            toolPart.tool,
            state.metadata,
            state.output,
            state.title,
          );
          const folder = await resolveFolder(
            toolPart.sessionID || sessionIdFromEvent(event.properties),
          );
          if (trackChanges(folder, changes) > 0) {
            await processHeartbeat(folder, opencodeVersion, opencodeClient);
          }
          continue;
        }

        if (isSessionFlushEvent(event)) {
          logger.debug(
            `Session event: ${event.type} - sending final heartbeat`,
          );
          const sessionID = sessionIdFromEvent(event.properties);
          if (sessionID && sessionFolders.has(sessionID)) {
            await onActivity(sessionID, true);
          } else {
            await flushAll(opencodeVersion, opencodeClient);
          }
        }
      }
    })().catch((err) => {
      logger.warn(`Event subscription stopped: ${err}`);
    });

    return async () => {
      controller.abort();
      await flushAll(opencodeVersion, opencodeClient);
    };
  },

  async server() {
    logger.warn(
      "opencode-wakatime targets OpenCode 2. OpenCode 1 should keep using opencode-wakatime.",
    );
    return {};
  },
};

export default plugin;
