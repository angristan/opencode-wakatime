import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getWakatimeResourcesDir } from "./wakatime-paths.js";

export interface State {
  lastHeartbeatAt?: number;
}

export function timestamp(): number {
  return Math.floor(Date.now() / 1000);
}

export function createState(projectFolder: string) {
  const hash = crypto
    .createHash("md5")
    .update(projectFolder)
    .digest("hex")
    .slice(0, 8);
  const stateFile = path.join(
    getWakatimeResourcesDir(),
    `opencode-${hash}.json`,
  );

  function readState(): State {
    try {
      const value = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      return value &&
        typeof value.lastHeartbeatAt === "number" &&
        Number.isFinite(value.lastHeartbeatAt)
        ? { lastHeartbeatAt: value.lastHeartbeatAt }
        : {};
    } catch {
      return {};
    }
  }

  function writeState(state: State): void {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch {
      // Tracking must not fail when the state directory is unavailable.
    }
  }

  return {
    readState,
    writeState,
    shouldSendHeartbeat(force = false): boolean {
      return force || timestamp() - (readState().lastHeartbeatAt ?? 0) >= 60;
    },
    updateLastHeartbeat(): void {
      writeState({ lastHeartbeatAt: timestamp() });
    },
  };
}
