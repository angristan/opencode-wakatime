import { describe, expect, it } from "vitest";
import { extractFileChanges } from "../index.js";

describe("extractFileChanges", () => {
  describe("edit tool", () => {
    it("extracts changes from filediff metadata", () => {
      const metadata = {
        filediff: {
          file: "/path/to/file.ts",
          before: "old content",
          after: "new content",
          additions: 5,
          deletions: 2,
        },
      };

      const result = extractFileChanges("edit", metadata, "");

      expect(result).toEqual([
        {
          file: "/path/to/file.ts",
          info: {
            additions: 5,
            deletions: 2,
            isWrite: false,
          },
        },
      ]);
    });

    it("falls back to filePath when filediff is missing", () => {
      const metadata = {
        filePath: "/path/to/file.ts",
      };

      const result = extractFileChanges("edit", metadata, "");

      expect(result).toEqual([
        {
          file: "/path/to/file.ts",
          info: {
            additions: 0,
            deletions: 0,
            isWrite: false,
          },
        },
      ]);
    });

    it("returns empty when no file info available", () => {
      const result = extractFileChanges("edit", {}, "");

      expect(result).toEqual([]);
    });

    it("handles undefined metadata", () => {
      const result = extractFileChanges("edit", undefined, "");

      expect(result).toEqual([]);
    });
  });

  describe("write tool", () => {
    it("extracts new file creation", () => {
      const metadata = {
        filepath: "/path/to/new-file.ts",
        exists: false,
      };

      const result = extractFileChanges("write", metadata, "");

      expect(result).toEqual([
        {
          file: "/path/to/new-file.ts",
          info: {
            additions: 0,
            deletions: 0,
            isWrite: true,
          },
        },
      ]);
    });

    it("extracts file overwrite", () => {
      const metadata = {
        filepath: "/path/to/existing-file.ts",
        exists: true,
      };

      const result = extractFileChanges("write", metadata, "");

      expect(result).toEqual([
        {
          file: "/path/to/existing-file.ts",
          info: {
            additions: 0,
            deletions: 0,
            isWrite: false,
          },
        },
      ]);
    });

    it("returns empty when filepath is missing", () => {
      const result = extractFileChanges("write", {}, "");

      expect(result).toEqual([]);
    });
  });

  describe("patch tool", () => {
    it("extracts multiple files from output", () => {
      const metadata = { diff: 10 };
      const output = `Patch applied successfully. 2 files changed:
  src/file1.ts
  src/file2.ts`;

      const result = extractFileChanges("patch", metadata, output);

      expect(result).toHaveLength(2);
      expect(result[0].file).toBe("src/file1.ts");
      expect(result[1].file).toBe("src/file2.ts");
    });

    it("distributes diff evenly across files", () => {
      const metadata = { diff: 10 };
      const output = `Changed:
  file1.ts
  file2.ts`;

      const result = extractFileChanges("patch", metadata, output);

      expect(result[0].info.additions).toBe(5);
      expect(result[1].info.additions).toBe(5);
    });

    it("handles negative diff as deletions", () => {
      const metadata = { diff: -6 };
      const output = `Changed:
  file1.ts
  file2.ts`;

      const result = extractFileChanges("patch", metadata, output);

      expect(result[0].info.deletions).toBe(3);
      expect(result[1].info.deletions).toBe(3);
    });

    it("returns empty when no files in output", () => {
      const metadata = { diff: 10 };
      const output = "No files changed";

      const result = extractFileChanges("patch", metadata, output);

      expect(result).toEqual([]);
    });
  });

  describe("multiedit tool", () => {
    it("extracts changes from multiple edit results", () => {
      const metadata = {
        results: [
          {
            filediff: {
              file: "/path/to/file1.ts",
              additions: 3,
              deletions: 1,
            },
          },
          {
            filediff: {
              file: "/path/to/file2.ts",
              additions: 7,
              deletions: 2,
            },
          },
        ],
      };

      const result = extractFileChanges("multiedit", metadata, "");

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        file: "/path/to/file1.ts",
        info: { additions: 3, deletions: 1, isWrite: false },
      });
      expect(result[1]).toEqual({
        file: "/path/to/file2.ts",
        info: { additions: 7, deletions: 2, isWrite: false },
      });
    });

    it("skips results without filediff", () => {
      const metadata = {
        results: [
          {
            filediff: { file: "/path/to/file1.ts", additions: 1, deletions: 0 },
          },
          { other: "data" },
          {
            filediff: { file: "/path/to/file2.ts", additions: 2, deletions: 0 },
          },
        ],
      };

      const result = extractFileChanges("multiedit", metadata, "");

      expect(result).toHaveLength(2);
    });

    it("returns empty when results is undefined", () => {
      const result = extractFileChanges("multiedit", {}, "");

      expect(result).toEqual([]);
    });
  });

  describe("read tool", () => {
    it("extracts file path from title", () => {
      const metadata = { preview: "file content preview" };
      const title = "/path/to/file.ts";

      const result = extractFileChanges("read", metadata, "", title);

      expect(result).toHaveLength(1);
      expect(result[0].file).toBe("/path/to/file.ts");
      expect(result[0].info.additions).toBe(0);
      expect(result[0].info.deletions).toBe(0);
      expect(result[0].info.isWrite).toBe(false);
    });

    it("returns empty array when no title provided", () => {
      const metadata = { preview: "file content preview" };

      const result = extractFileChanges("read", metadata, "");

      expect(result).toEqual([]);
    });
  });

  describe("glob tool", () => {
    it("returns empty array (search tools are not tracked)", () => {
      const metadata = { pattern: "**/*.ts" };

      const result = extractFileChanges("glob", metadata, "");

      expect(result).toEqual([]);
    });
  });

  describe("grep tool", () => {
    it("returns empty array (search tools are not tracked)", () => {
      const metadata = { pattern: "TODO" };

      const result = extractFileChanges("grep", metadata, "");

      expect(result).toEqual([]);
    });
  });

  describe("codesearch tool", () => {
    it("returns empty array (search tools are not tracked)", () => {
      const metadata = { query: "function" };

      const result = extractFileChanges("codesearch", metadata, "");

      expect(result).toEqual([]);
    });
  });

  describe("bash tool", () => {
    it("returns empty array (bash commands are not tracked)", () => {
      const metadata = { command: "npm install" };

      const result = extractFileChanges("bash", metadata, "");

      expect(result).toEqual([]);
    });
  });

  describe("unknown tool", () => {
    it("returns empty array for unknown tools", () => {
      const metadata = { some: "data" };

      const result = extractFileChanges("unknown-tool", metadata, "");

      expect(result).toEqual([]);
    });
  });
});
