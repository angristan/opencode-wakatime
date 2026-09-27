import * as fs from "node:fs";
import * as path from "node:path";
import type { FileChange, FileChangeInfo } from "./file-changes.js";
import { LogLevel, logger } from "./logger.js";
import { createState } from "./state.js";
import {
  ensureCliInstalled,
  flushHeartbeats,
  type HeartbeatParams,
  sendHeartbeats,
} from "./wakatime.js";
import { getWakatimeConfigFilePath } from "./wakatime-paths.js";

export function resolveProjectFolder(
  worktree: string | undefined,
  projectWorktree: string | undefined,
  cwd: string = process.cwd(),
): string {
  return worktree || projectWorktree || cwd;
}

export interface TrackerOptions {
  projectFolder: string;
  directory: string;
  opencodeVersion: string;
  opencodeClient: string;
  waitForDelivery?: boolean;
}

export async function createTracker(options: TrackerOptions) {
  try {
    const cfg = fs.readFileSync(getWakatimeConfigFilePath(), "utf-8");
    if (/^\s*debug\s*=\s*true\s*$/m.test(cfg)) logger.setLevel(LogLevel.DEBUG);
  } catch {
    // The user may not have configured WakaTime yet.
  }

  const state = createState(options.projectFolder);
  const sessions = new Map<string, Map<string, FileChangeInfo>>();
  const processedCalls = new Set<string>();
  const interruptedBatches = new Set<HeartbeatParams[]>();

  if (!(await ensureCliInstalled())) {
    logger.warn(
      "WakaTime CLI could not be installed. Please install it manually: https://wakatime.com/terminal",
    );
  } else {
    logger.info(
      `OpenCode WakaTime plugin initialized for project: ${path.basename(options.projectFolder)}`,
    );
  }

  async function processHeartbeat(
    force = false,
    sessionID?: string,
  ): Promise<void> {
    if (!state.shouldSendHeartbeat(force)) return;
    const files = new Map<string, FileChangeInfo>();
    for (const [id, changes] of sessions) {
      if (sessionID !== undefined && id !== sessionID) continue;
      for (const [file, info] of changes) {
        const previous = files.get(file);
        files.set(file, {
          additions: (previous?.additions ?? 0) + info.additions,
          deletions: (previous?.deletions ?? 0) + info.deletions,
          isWrite: !!previous?.isWrite || info.isWrite,
        });
      }
      sessions.delete(id);
    }

    if (files.size > 0) {
      const heartbeats: HeartbeatParams[] = Array.from(
        files,
        ([entity, info]) => ({
          entity,
          projectFolder: options.projectFolder,
          lineChanges: info.additions - info.deletions,
          category: "ai coding",
          isWrite: info.isWrite,
          opencodeVersion: options.opencodeVersion,
          opencodeClient: options.opencodeClient,
        }),
      );
      state.updateLastHeartbeat();
      const delivery = sendHeartbeats(heartbeats).then((result) => {
        if (result === "interrupted") interruptedBatches.add(heartbeats);
      });
      if (options.waitForDelivery) await delivery;
    }
    if (force) await flushHeartbeats();
  }

  return {
    processHeartbeat,
    async flush(): Promise<void> {
      await processHeartbeat(true);
      // V2 may cancel a send started by a completion event before plugin cleanup.
      // Retry each interrupted batch once; normal CLI exits may have queued it offline.
      const retry = Array.from(interruptedBatches);
      interruptedBatches.clear();
      for (const batch of retry) await sendHeartbeats(batch);
    },
    async track(
      sessionID: string,
      callID: string,
      changes: FileChange[],
    ): Promise<void> {
      if (changes.length === 0) return;
      const key = JSON.stringify([sessionID, callID]);
      if (processedCalls.has(key)) return;
      processedCalls.add(key);
      if (processedCalls.size > 1000) {
        for (const old of Array.from(processedCalls).slice(0, 500))
          processedCalls.delete(old);
      }

      const files =
        sessions.get(sessionID) ?? new Map<string, FileChangeInfo>();
      for (const change of changes) {
        const file = path.resolve(options.directory, change.file);
        try {
          if (fs.statSync(file).isDirectory()) continue;
        } catch {
          // Deleted files still count as activity.
        }
        const previous = files.get(file);
        files.set(file, {
          additions: (previous?.additions ?? 0) + (change.info.additions ?? 0),
          deletions: (previous?.deletions ?? 0) + (change.info.deletions ?? 0),
          isWrite: !!previous?.isWrite || !!change.info.isWrite,
        });
      }
      if (files.size > 0) sessions.set(sessionID, files);
      await processHeartbeat();
    },
  };
}

export type Tracker = Awaited<ReturnType<typeof createTracker>>;

export function getClientName(): string {
  const client = process.env.OPENCODE_CLIENT || "cli";
  return client === "app" ? "web" : client;
}
