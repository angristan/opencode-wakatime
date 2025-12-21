import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the fs and os modules before imports
vi.mock("node:fs");
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/user"),
  platform: vi.fn(() => "darwin"),
}));

// Import after mocks are set up
const {
  readState,
  shouldSendHeartbeat,
  timestamp,
  updateLastHeartbeat,
  writeState,
} = await import("../state.js");

describe("state", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue("/home/user");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("timestamp", () => {
    it("returns current time in seconds", () => {
      const now = Date.now();
      vi.setSystemTime(now);

      const result = timestamp();

      expect(result).toBe(Math.floor(now / 1000));
    });

    it("rounds down to nearest second", () => {
      vi.setSystemTime(1700000000500); // 500ms past the second

      const result = timestamp();

      expect(result).toBe(1700000000);
    });
  });

  describe("readState", () => {
    it("returns parsed state from file", () => {
      const mockState = { lastHeartbeatAt: 1700000000 };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockState));

      const result = readState();

      expect(result).toEqual(mockState);
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join("/home/user", ".wakatime", "opencode.json"),
        "utf-8",
      );
    });

    it("returns empty object when file does not exist", () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const result = readState();

      expect(result).toEqual({});
    });

    it("returns empty object on invalid JSON", () => {
      vi.mocked(fs.readFileSync).mockReturnValue("invalid json");

      const result = readState();

      expect(result).toEqual({});
    });
  });

  describe("writeState", () => {
    it("writes state to file", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const mockState = { lastHeartbeatAt: 1700000000 };

      writeState(mockState);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join("/home/user", ".wakatime", "opencode.json"),
        JSON.stringify(mockState, null, 2),
      );
    });

    it("creates directory if it does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      writeState({ lastHeartbeatAt: 1700000000 });

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        path.join("/home/user", ".wakatime"),
        { recursive: true },
      );
    });

    it("silently handles write errors", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error("Write error");
      });

      // Should not throw
      expect(() => writeState({ lastHeartbeatAt: 1700000000 })).not.toThrow();
    });
  });

  describe("shouldSendHeartbeat", () => {
    it("returns true when force is true", () => {
      const result = shouldSendHeartbeat(true);

      expect(result).toBe(true);
    });

    it("returns true when no previous heartbeat exists", () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const result = shouldSendHeartbeat();

      expect(result).toBe(true);
    });

    it("returns true when last heartbeat was more than 60 seconds ago", () => {
      const now = 1700000100;
      vi.setSystemTime(now * 1000);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ lastHeartbeatAt: 1700000000 }), // 100 seconds ago
      );

      const result = shouldSendHeartbeat();

      expect(result).toBe(true);
    });

    it("returns false when last heartbeat was less than 60 seconds ago", () => {
      const now = 1700000030;
      vi.setSystemTime(now * 1000);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ lastHeartbeatAt: 1700000000 }), // 30 seconds ago
      );

      const result = shouldSendHeartbeat();

      expect(result).toBe(false);
    });

    it("returns true when last heartbeat was exactly 60 seconds ago", () => {
      const now = 1700000060;
      vi.setSystemTime(now * 1000);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ lastHeartbeatAt: 1700000000 }), // 60 seconds ago
      );

      const result = shouldSendHeartbeat();

      expect(result).toBe(true);
    });
  });

  describe("updateLastHeartbeat", () => {
    it("writes current timestamp to state", () => {
      const now = 1700000000;
      vi.setSystemTime(now * 1000);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      updateLastHeartbeat();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify({ lastHeartbeatAt: now }, null, 2),
      );
    });
  });
});
