import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock modules before imports
vi.mock("node:fs");
vi.mock("node:child_process");
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/user"),
  platform: vi.fn(() => "darwin"),
  arch: vi.fn(() => "x64"),
}));

// Import after mocks
const { Dependencies } = await import("../dependencies.js");

describe("Dependencies", () => {
  let deps: InstanceType<typeof Dependencies>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue("/home/user");
    vi.mocked(os.platform).mockReturnValue("darwin");
    vi.mocked(os.arch).mockReturnValue("x64");
    // Default: execSync throws (command not found)
    vi.mocked(child_process.execSync).mockImplementation(() => {
      throw new Error("Command not found");
    });
    deps = new Dependencies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getCliLocationGlobal", () => {
    it("returns path when wakatime-cli is found globally on Unix", () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      vi.mocked(child_process.execSync).mockReturnValue(
        "/usr/local/bin/wakatime-cli\n",
      );

      const result = deps.getCliLocationGlobal();

      expect(result).toBe("/usr/local/bin/wakatime-cli");
    });

    it("returns path when wakatime-cli.exe is found globally on Windows", () => {
      vi.mocked(os.platform).mockReturnValue("win32");
      vi.mocked(child_process.execSync).mockReturnValue(
        "C:\\Program Files\\wakatime-cli.exe\n",
      );

      const result = deps.getCliLocationGlobal();

      expect(result).toBe("C:\\Program Files\\wakatime-cli.exe");
    });

    it("returns undefined when wakatime-cli is not found", () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      vi.mocked(child_process.execSync).mockImplementation(() => {
        throw new Error("Command not found");
      });

      const result = deps.getCliLocationGlobal();

      expect(result).toBeUndefined();
    });

    it("returns undefined on execSync error", () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      vi.mocked(child_process.execSync).mockImplementation(() => {
        throw new Error("Command not found");
      });

      const result = deps.getCliLocationGlobal();

      expect(result).toBeUndefined();
    });
  });

  describe("getCliLocation", () => {
    it("returns global CLI location when available", () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      vi.mocked(child_process.execSync).mockReturnValue(
        "/usr/local/bin/wakatime-cli\n",
      );

      const result = deps.getCliLocation();

      expect(result).toBe("/usr/local/bin/wakatime-cli");
    });

    it("returns local CLI location when global not available on macOS", () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      vi.mocked(os.arch).mockReturnValue("arm64");
      vi.mocked(child_process.execSync).mockImplementation(() => {
        throw new Error("Command not found");
      });

      const result = deps.getCliLocation();

      expect(result).toBe(
        path.join("/home/user", ".wakatime", "wakatime-cli-darwin-arm64"),
      );
    });

    it("returns local CLI location with .exe on Windows", () => {
      vi.mocked(os.platform).mockReturnValue("win32");
      vi.mocked(os.arch).mockReturnValue("x64");
      vi.mocked(child_process.execSync).mockImplementation(() => {
        throw new Error("Command not found");
      });

      const result = deps.getCliLocation();

      expect(result).toBe(
        path.join("/home/user", ".wakatime", "wakatime-cli-windows-amd64.exe"),
      );
    });

    it("returns cached location on subsequent calls", () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      vi.mocked(child_process.execSync).mockReturnValue(
        "/usr/local/bin/wakatime-cli\n",
      );

      const first = deps.getCliLocation();
      const second = deps.getCliLocation();

      expect(first).toBe(second);
      // execSync should only be called once due to caching
      expect(child_process.execSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("isCliInstalled", () => {
    it("returns true when CLI exists at location", () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      vi.mocked(child_process.execSync).mockReturnValue(
        "/usr/local/bin/wakatime-cli\n",
      );
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = deps.isCliInstalled();

      expect(result).toBe(true);
    });

    it("returns false when CLI does not exist", () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      vi.mocked(os.arch).mockReturnValue("x64");
      vi.mocked(child_process.execSync).mockImplementation(() => {
        throw new Error("Command not found");
      });
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = deps.isCliInstalled();

      expect(result).toBe(false);
    });
  });

  describe("architecture mapping", () => {
    it.each([
      ["x64", "amd64"],
      ["ia32", "386"],
      ["arm64", "arm64"],
      ["arm", "arm"],
    ])("maps %s to %s", (nodeArch, expectedArch) => {
      vi.mocked(os.platform).mockReturnValue("linux");
      vi.mocked(os.arch).mockReturnValue(nodeArch as NodeJS.Architecture);
      vi.mocked(child_process.execSync).mockImplementation(() => {
        throw new Error("Command not found");
      });

      const location = deps.getCliLocation();

      expect(location).toContain(expectedArch);
    });
  });

  describe("platform mapping", () => {
    it.each([
      ["win32", "windows"],
      ["darwin", "darwin"],
      ["linux", "linux"],
    ])("maps %s platform to %s in binary name", (platform, expected) => {
      vi.mocked(os.platform).mockReturnValue(platform as NodeJS.Platform);
      vi.mocked(os.arch).mockReturnValue("x64");
      vi.mocked(child_process.execSync).mockImplementation(() => {
        throw new Error("Command not found");
      });

      const location = deps.getCliLocation();

      expect(location).toContain(expected);
    });
  });
});
