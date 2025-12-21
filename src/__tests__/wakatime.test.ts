import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock modules before imports
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/user"),
  platform: vi.fn(() => "darwin"),
  arch: vi.fn(() => "x64"),
}));
vi.mock("node:fs");
vi.mock("which", () => ({
  default: { sync: vi.fn(() => null) },
  sync: vi.fn(() => null),
}));

// Import after mocks
const { buildExecOptions, formatArgs, isWindows } = await import(
  "../wakatime.js"
);

describe("wakatime", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
});
