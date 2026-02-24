import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/user"),
}));

const {
  getWakatimeConfigFilePath,
  getWakatimeHomeDir,
  getWakatimeResourcesDir,
} = await import("../wakatime-paths.js");

describe("wakatime-paths", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.mocked(os.homedir).mockReturnValue("/home/user");
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("uses default home and .wakatime resources when WAKATIME_HOME is not set", () => {
    delete process.env.WAKATIME_HOME;

    expect(getWakatimeHomeDir()).toBe("/home/user");
    expect(getWakatimeResourcesDir()).toBe(
      path.join("/home/user", ".wakatime"),
    );
    expect(getWakatimeConfigFilePath()).toBe(
      path.join("/home/user", ".wakatime.cfg"),
    );
  });

  it("uses WAKATIME_HOME directly for resources and config", () => {
    process.env.WAKATIME_HOME = "/custom/wakatime";

    expect(getWakatimeHomeDir()).toBe("/custom/wakatime");
    expect(getWakatimeResourcesDir()).toBe("/custom/wakatime");
    expect(getWakatimeConfigFilePath()).toBe(
      path.join("/custom/wakatime", ".wakatime.cfg"),
    );
  });

  it("expands ~ in WAKATIME_HOME", () => {
    process.env.WAKATIME_HOME = "~/waka-home";

    expect(getWakatimeHomeDir()).toBe(path.join("/home/user", "waka-home"));
    expect(getWakatimeResourcesDir()).toBe(
      path.join("/home/user", "waka-home"),
    );
  });

  it("treats empty WAKATIME_HOME as unset", () => {
    process.env.WAKATIME_HOME = "   ";

    expect(getWakatimeHomeDir()).toBe("/home/user");
    expect(getWakatimeResourcesDir()).toBe(
      path.join("/home/user", ".wakatime"),
    );
  });
});
