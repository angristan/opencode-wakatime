import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  const children: Array<{
    emit: (event: string, ...args: unknown[]) => void;
    stdin: {
      end: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
    };
  }> = [];

  const spawn = vi.fn((..._args: unknown[]) => {
    const listeners = new Map<string, Listener>();
    const child = {
      emit: (event: string, ...args: unknown[]) =>
        listeners.get(event)?.(...args),
      on: vi.fn((event: string, listener: Listener) => {
        listeners.set(event, listener);
        return child;
      }),
      stdin: {
        end: vi.fn(),
        on: vi.fn(),
      },
    };
    children.push(child);
    return child;
  });

  return { children, spawn };
});

// Mock modules before imports
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/user"),
  platform: vi.fn(() => "darwin"),
  arch: vi.fn(() => "x64"),
}));
vi.mock("node:fs");
vi.mock("node:child_process", () => ({ spawn: childProcessMocks.spawn }));
vi.mock("../dependencies.js", () => ({
  dependencies: {
    checkAndInstallCli: vi.fn(),
    getCliLocation: vi.fn(() => "/tmp/wakatime-cli"),
    getCliLocationGlobal: vi.fn(),
    isCliInstalled: vi.fn(() => true),
  },
}));
vi.mock("which", () => ({
  default: { sync: vi.fn(() => null) },
  sync: vi.fn(() => null),
}));

// Import after mocks
const { buildExecOptions, formatArgs, isWindows, sendHeartbeats } =
  await import("../wakatime.js");

describe("wakatime", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    childProcessMocks.children.length = 0;
    vi.mocked(os.platform).mockReturnValue("darwin");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isWindows", () => {
    it("returns true on Windows", () => {
      vi.mocked(os.platform).mockReturnValue("win32");

      expect(isWindows()).toBe(true);
    });

    it("returns false on macOS", () => {
      vi.mocked(os.platform).mockReturnValue("darwin");

      expect(isWindows()).toBe(false);
    });

    it("returns false on Linux", () => {
      vi.mocked(os.platform).mockReturnValue("linux");

      expect(isWindows()).toBe(false);
    });
  });

  describe("formatArgs", () => {
    it("returns empty string for empty array", () => {
      expect(formatArgs([])).toBe("");
    });

    it("joins simple arguments with spaces", () => {
      expect(formatArgs(["--flag", "value"])).toBe("--flag value");
    });

    it("quotes arguments containing spaces", () => {
      expect(formatArgs(["--path", "/some/path with spaces/file.txt"])).toBe(
        '--path "/some/path with spaces/file.txt"',
      );
    });

    it("escapes quotes within arguments", () => {
      expect(formatArgs(['say "hello"'])).toBe('"say \\"hello\\""');
    });

    it("handles mixed arguments", () => {
      expect(formatArgs(["--entity", "file.ts", "--plugin", "my plugin"])).toBe(
        '--entity file.ts --plugin "my plugin"',
      );
    });

    it("handles arguments with both spaces and quotes", () => {
      expect(formatArgs(['path with "quotes"'])).toBe(
        '"path with \\"quotes\\""',
      );
    });
  });

  describe("buildExecOptions", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("always includes windowsHide", () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      process.env.HOME = "/home/user";

      const options = buildExecOptions();

      expect(options.windowsHide).toBe(true);
      expect(options.stdio).toEqual(["pipe", "ignore", "ignore"]);
    });

    it("does not set WAKATIME_HOME when HOME is set", () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      process.env.HOME = "/home/user";

      const options = buildExecOptions();

      expect(options.env).toBeUndefined();
    });

    it("does not set WAKATIME_HOME when WAKATIME_HOME is already set", () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      delete process.env.HOME;
      process.env.WAKATIME_HOME = "/custom/wakatime";

      const options = buildExecOptions();

      expect(options.env).toBeUndefined();
    });

    it("sets WAKATIME_HOME on Unix when neither HOME nor WAKATIME_HOME is set", () => {
      vi.mocked(os.platform).mockReturnValue("linux");
      vi.mocked(os.homedir).mockReturnValue("/home/user");
      delete process.env.HOME;
      delete process.env.WAKATIME_HOME;

      const options = buildExecOptions();

      expect(options.env?.WAKATIME_HOME).toBe("/home/user");
    });

    it("does not modify env on Windows", () => {
      vi.mocked(os.platform).mockReturnValue("win32");
      delete process.env.HOME;
      delete process.env.WAKATIME_HOME;

      const options = buildExecOptions();

      expect(options.env).toBeUndefined();
    });
  });

  describe("sendHeartbeats", () => {
    it("sends multiple heartbeats through one CLI process", async () => {
      const promise = sendHeartbeats([
        {
          entity: "/project/first.ts",
          projectFolder: "/project",
          lineChanges: 3,
          isWrite: true,
          opencodeClient: "cli",
          opencodeVersion: "1.2.3",
        },
        {
          entity: "/project/second.ts",
          projectFolder: "/project",
          lineChanges: -2,
          opencodeClient: "cli",
          opencodeVersion: "1.2.3",
        },
      ]);

      expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
      const args = childProcessMocks.spawn.mock.calls[0][1] as string[];
      expect(args).toContain("--extra-heartbeats");

      const child = childProcessMocks.children[0];
      const input = child.stdin.end.mock.calls[0][0] as string;
      expect(JSON.parse(input)).toEqual([
        {
          ai_line_changes: -2,
          category: "ai coding",
          entity: "/project/second.ts",
          entity_type: "file",
          time: expect.any(Number),
        },
      ]);

      child.emit("exit", 0, null);
      await expect(promise).resolves.toBeUndefined();
    });

    it("does not spawn a process for an empty batch", async () => {
      await sendHeartbeats([]);

      expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    });
  });
});
