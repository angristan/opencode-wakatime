import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const STATE_FILE = path.join(os.homedir(), ".wakatime", "opencode.json");

export interface State {
  lastHeartbeatAt?: number;
}

export function readState(): State {
  try {
    const content = fs.readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(content) as State;
  } catch {
    return {};
  }
}

export function writeState(state: State): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // Silently ignore state write errors
  }
}

export function timestamp(): number {
  return Math.floor(Date.now() / 1000);
}

export function shouldSendHeartbeat(force: boolean = false): boolean {
  if (force) return true;

  try {
    const state = readState();
    const lastHeartbeat = state.lastHeartbeatAt ?? 0;
    // Rate limit: only send heartbeat every 60 seconds
    return timestamp() - lastHeartbeat >= 60;
  } catch {
    return true;
  }
}

export function updateLastHeartbeat(): void {
  writeState({ lastHeartbeatAt: timestamp() });
}
