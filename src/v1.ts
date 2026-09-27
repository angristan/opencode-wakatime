import * as fs from "node:fs";
import * as path from "node:path";
import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { extractFileChanges } from "./file-changes.js";
import { logger } from "./logger.js";
import {
  createTracker,
  getClientName,
  resolveProjectFolder,
} from "./tracker.js";
import { getWakatimeResourcesDir } from "./wakatime-paths.js";

interface HttpClient {
  get(options: { url: string }): Promise<{ data?: { version?: string } }>;
}

async function getVersion(client: unknown): Promise<string> {
  const cacheFile = path.join(
    getWakatimeResourcesDir(),
    "opencode-version-cache.json",
  );
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    if (
      typeof cached.version === "string" &&
      Date.now() - cached.timestamp < 60_000
    )
      return cached.version;
  } catch {
    // Fetch a version if the cache is missing or invalid.
  }
  try {
    const sdk = client as {
      global?: { _client?: HttpClient };
      _client?: HttpClient;
    };
    const httpClient = sdk.global?._client ?? sdk._client;
    const response = await httpClient?.get({ url: "/global/health" });
    const version = response?.data?.version;
    if (version) {
      try {
        fs.writeFileSync(
          cacheFile,
          JSON.stringify({ version, timestamp: Date.now() }),
        );
      } catch {
        // The version remains usable if the cache cannot be written.
      }
      return version;
    }
  } catch (error) {
    logger.warn(`Could not fetch OpenCode version: ${error}`);
  }
  return "unknown";
}

interface ToolPart {
  type: "tool";
  sessionID: string;
  callID: string;
  tool: string;
  state: {
    status: string;
    metadata?: Record<string, unknown>;
    output?: string;
    title?: string;
  };
}

export const v1Plugin: Plugin = async (ctx) => {
  const projectFolder = resolveProjectFolder(
    ctx.worktree,
    ctx.project.worktree,
  );
  const tracker = await createTracker({
    projectFolder,
    directory: ctx.directory || projectFolder,
    opencodeVersion: await getVersion(ctx.client),
    opencodeClient: getClientName(),
  });

  const hooks: Hooks & { dispose: () => Promise<void> } = {
    "chat.message": async () => tracker.processHeartbeat(),
    event: async ({ event }) => {
      if (event.type === "message.part.updated") {
        const part = event.properties.part as ToolPart;
        if (part.type !== "tool" || part.state.status !== "completed") return;
        await tracker.track(
          part.sessionID,
          part.callID,
          extractFileChanges(
            part.tool,
            part.state.metadata,
            part.state.output ?? "",
            part.state.title,
          ),
        );
      }
      if (event.type === "session.idle") {
        await tracker.processHeartbeat(true, event.properties.sessionID);
      }
      if (event.type === "session.deleted") {
        await tracker.processHeartbeat(true, event.properties.info.id);
      }
    },
    dispose: async () => tracker.flush(),
  };
  return hooks;
};
