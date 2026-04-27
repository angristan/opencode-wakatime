import { describe, expect, it } from "vitest";
import {
  buildWakatimeAuthHeader,
  formatCacheAge,
  formatDuration,
  formatWakatimePanelLines,
  parseWakatimeApiKey,
} from "../tui-panel.js";

describe("tui-panel", () => {
  describe("parseWakatimeApiKey", () => {
    it("reads api_key from wakatime config", () => {
      expect(parseWakatimeApiKey("[settings]\napi_key = abc123\n")).toBe(
        "abc123",
      );
    });

    it("ignores comments and empty api keys", () => {
      expect(
        parseWakatimeApiKey("# api_key = nope\napi_key =   \n"),
      ).toBeUndefined();
    });

    it("unquotes api keys", () => {
      expect(parseWakatimeApiKey('api_key = "abc123"')).toBe("abc123");
    });
  });

  describe("formatting", () => {
    it("formats durations", () => {
      expect(formatDuration(0)).toBe("0 mins");
      expect(formatDuration(60)).toBe("1 min");
      expect(formatDuration(3_900)).toBe("1 hr 5 mins");
    });

    it("formats cache age", () => {
      expect(formatCacheAge(12_000)).toBe("12s");
      expect(formatCacheAge(90_000)).toBe("2m");
    });

    it("formats status bar lines with top projects", () => {
      const lines = formatWakatimePanelLines(
        {
          data: {
            grand_total: { text: "2 hrs", total_seconds: 7_200 },
            categories: [
              { name: "AI Coding", text: "45 mins", total_seconds: 2_700 },
            ],
            projects: [
              { name: "api", text: "1 hr", total_seconds: 3_600 },
              { name: "web", text: "30 mins", total_seconds: 1_800 },
            ],
          },
          fetchedAt: 1_000,
        },
        16_000,
      );

      expect(lines).toEqual([
        "Today: 2 hrs",
        "AI Coding: 45 mins",
        "api: 1 hr",
        "Updated 15s ago",
      ]);
    });

    it("handles unavailable payloads", () => {
      expect(formatWakatimePanelLines(undefined)).toEqual([
        "WakaTime unavailable",
      ]);
    });

    it("builds WakaTime basic auth header", () => {
      expect(buildWakatimeAuthHeader("abc123")).toBe("Basic YWJjMTIz");
    });
  });
});
