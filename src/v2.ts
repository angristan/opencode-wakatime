import * as path from "node:path";
import { setTimeout } from "node:timers/promises";
import { extractV2FileChanges } from "./file-changes.js";
import { logger } from "./logger.js";
import { createTracker, getClientName } from "./tracker.js";
import type { Registration, V2Context } from "./v2-api.js";

export async function setupV2(ctx: V2Context): Promise<() => Promise<void>> {
  const tracker = await createTracker({
    projectFolder: ctx.location.project.directory,
    directory: ctx.location.directory,
    opencodeVersion: ctx.app.version,
    opencodeClient: getClientName(),
  });
  const controller = new AbortController();
  const registrations: Registration[] = [];
  const trackedSessions = new Set<string>();
  const matchesLocation = (directory: string) =>
    path.resolve(directory) === path.resolve(ctx.location.directory);

  try {
    registrations.push(
      await ctx.tool.hook("execute.after", async (event) => {
        if (controller.signal.aborted || event.status !== "completed") return;
        const changes = extractV2FileChanges(
          event.tool,
          event.input,
          event.result,
        );
        if (changes.length === 0) return;
        try {
          const session = await ctx.session.get({ sessionID: event.sessionID });
          if (
            controller.signal.aborted ||
            !matchesLocation(session.location.directory)
          )
            return;
          trackedSessions.add(event.sessionID);
          await tracker.track(event.sessionID, event.id, changes);
        } catch (error) {
          logger.warn(`Could not track OpenCode tool activity: ${error}`);
        }
      }),
    );
    registrations.push(
      await ctx.session.hook("prompt", async (event) => {
        if (!controller.signal.aborted)
          await tracker.processHeartbeat(false, event.sessionID);
      }),
    );
  } catch (error) {
    controller.abort();
    await Promise.all(
      registrations.map((registration) => registration.dispose()),
    );
    throw error;
  }

  const events = (async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break;
          const sessionID = event.data.sessionID;
          if (!sessionID || !trackedSessions.has(sessionID)) continue;
          if (event.location && !matchesLocation(event.location.directory))
            continue;
          if (
            event.type === "session.deleted" ||
            event.type === "session.idle" ||
            (event.type === "session.status" &&
              event.data.status?.type === "idle")
          ) {
            trackedSessions.delete(sessionID);
            await tracker.processHeartbeat(true, sessionID);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted)
          logger.warn(`OpenCode event stream disconnected: ${error}`);
      }
      if (!controller.signal.aborted) {
        // Reconnect after a failed or closed stream without blocking plugin setup.
        await setTimeout(1000, undefined, { signal: controller.signal }).catch(
          () => {},
        );
      }
    }
  })();

  return async () => {
    controller.abort();
    await events;
    await tracker.processHeartbeat(true);
  };
}
