import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createState, timestamp } from "../state.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-state-"));
  vi.stubEnv("WAKATIME_HOME", home);
  vi.useFakeTimers();
  vi.setSystemTime(1700000000500);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("project state", () => {
  it("returns seconds rounded down", () => {
    expect(timestamp()).toBe(1700000000);
  });

  it("allows the first heartbeat when the state file is missing", () => {
    const state = createState("/project/a");
    expect(state.readState()).toEqual({});
    expect(state.shouldSendHeartbeat()).toBe(true);
  });

  it("persists timestamps and enforces a sixty-second interval", () => {
    const state = createState("/project/a");
    state.updateLastHeartbeat();
    expect(state.readState()).toEqual({ lastHeartbeatAt: 1700000000 });
    expect(createState("/project/a").shouldSendHeartbeat()).toBe(false);
    vi.advanceTimersByTime(59_000);
    expect(state.shouldSendHeartbeat()).toBe(false);
    expect(state.shouldSendHeartbeat(true)).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(state.shouldSendHeartbeat()).toBe(true);
  });

  it("keeps existing instances bound to their own project", () => {
    const a = createState("/project/a");
    const b = createState("/project/b");
    a.updateLastHeartbeat();
    expect(a.shouldSendHeartbeat()).toBe(false);
    expect(b.shouldSendHeartbeat()).toBe(true);
    b.writeState({ lastHeartbeatAt: 1699999990 });
    expect(a.readState()).toEqual({ lastHeartbeatAt: 1700000000 });
    expect(b.readState()).toEqual({ lastHeartbeatAt: 1699999990 });
    expect(fs.readdirSync(home)).toHaveLength(2);
  });

  it("creates the resources directory under WAKATIME_HOME", () => {
    const nested = path.join(home, "nested");
    vi.stubEnv("WAKATIME_HOME", nested);
    const state = createState("/project/a");
    state.writeState({ lastHeartbeatAt: 10 });
    expect(fs.readdirSync(nested)).toHaveLength(1);
    expect(state.readState()).toEqual({ lastHeartbeatAt: 10 });
  });

  it.each([
    "invalid json",
    "null",
    "[]",
    '{"lastHeartbeatAt":"invalid"}',
  ])("ignores corrupt state: %s", (content) => {
    const state = createState("/project/a");
    state.writeState({ lastHeartbeatAt: 10 });
    fs.writeFileSync(path.join(home, fs.readdirSync(home)[0]), content);
    expect(state.readState()).toEqual({});
    expect(state.shouldSendHeartbeat()).toBe(true);
  });

  it("does not throw when the resources path is a file", () => {
    const file = path.join(home, "not-a-directory");
    fs.writeFileSync(file, "");
    vi.stubEnv("WAKATIME_HOME", file);
    const state = createState("/project/a");
    expect(() => state.updateLastHeartbeat()).not.toThrow();
    expect(state.shouldSendHeartbeat()).toBe(true);
  });
});
