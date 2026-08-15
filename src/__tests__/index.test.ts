import { describe, expect, it } from "vitest";
import { extractFileChanges, resolveProjectFolder } from "../index.js";

describe("resolveProjectFolder", () => {
  it("uses the current working directory", () => {
    expect(resolveProjectFolder("/cwd")).toBe("/cwd");
  });

  it("falls back to process.cwd() when no argument is given", () => {
    expect(resolveProjectFolder()).toBe(process.cwd());
  });
});

describe("extractFileChanges", () => {
  describe("edit tool", () => {
    it("extracts changes from result metadata files", () => {
      const metadata = {
        files: [
          {
            file: "/path/to/file.ts",
            additions: 5,
            deletions: 2,
            status: "modified",
          },
        ],
      };

      const result = extractFileChanges("edit", undefined, metadata);

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

    it("extracts changes from tool output files", () => {
      const output = {
        files: [
          {
            file: "/path/to/file.ts",
            additions: 3,
            deletions: 1,
            status: "modified",
          },
        ],
        replacements: 1,
      };

      const result = extractFileChanges("edit", output, undefined);

      expect(result).toEqual([
        {
          file: "/path/to/file.ts",
          info: {
            additions: 3,
            deletions: 1,
            isWrite: false,
          },
        },
      ]);
    });

    it("marks added files as writes", () => {
      const output = {
        files: [
          {
            file: "/path/to/file.ts",
            additions: 1,
            deletions: 0,
            status: "added",
          },
        ],
      };

      const result = extractFileChanges("edit", output, undefined);

      expect(result[0]?.info.isWrite).toBe(true);
    });

    it("returns empty when no file info available", () => {
      const result = extractFileChanges("edit", {}, {});

      expect(result).toEqual([]);
    });

    it("returns empty when output and metadata are undefined", () => {
      const result = extractFileChanges("edit", undefined, undefined);

      expect(result).toEqual([]);
    });

    it("prefers output files over metadata files", () => {
      const output = { files: [{ file: "/a.ts", additions: 1, deletions: 0 }] };
      const metadata = {
        files: [{ file: "/b.ts", additions: 1, deletions: 0 }],
      };

      const result = extractFileChanges("edit", output, metadata);

      expect(result).toHaveLength(1);
      expect(result[0]?.file).toBe("/a.ts");
    });
  });

  describe("write tool", () => {
    it("extracts new file creation from output resource", () => {
      const output = {
        operation: "write",
        target: "/path/to/new-file.ts",
        resource: "/path/to/new-file.ts",
        existed: false,
      };

      const result = extractFileChanges("write", output, undefined);

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
      const output = {
        operation: "write",
        target: "/path/to/existing-file.ts",
        resource: "/path/to/existing-file.ts",
        existed: true,
      };

      const result = extractFileChanges("write", output, undefined);

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

    it("falls back to target when resource is missing", () => {
      const output = {
        operation: "write",
        target: "/path/to/file.ts",
        existed: false,
      };

      const result = extractFileChanges("write", output, undefined);

      expect(result).toEqual([
        {
          file: "/path/to/file.ts",
          info: {
            additions: 0,
            deletions: 0,
            isWrite: true,
          },
        },
      ]);
    });

    it("returns empty when no file path is available", () => {
      const result = extractFileChanges("write", {}, {});

      expect(result).toEqual([]);
    });
  });

  describe("patch tool", () => {
    it("extracts multiple files from output files array", () => {
      const output = {
        files: [
          { file: "src/file1.ts", additions: 5, deletions: 0 },
          { file: "src/file2.ts", additions: 2, deletions: 1 },
        ],
      };

      const result = extractFileChanges("patch", output, undefined);

      expect(result).toHaveLength(2);
      expect(result[0]?.file).toBe("src/file1.ts");
      expect(result[1]?.file).toBe("src/file2.ts");
    });

    it("returns empty when no files present", () => {
      const result = extractFileChanges("patch", {}, {});

      expect(result).toEqual([]);
    });
  });

  describe("read tool", () => {
    it("returns empty (reads do not modify files)", () => {
      const output = { path: "/path/to/file.ts" };

      const result = extractFileChanges("read", output, {});

      expect(result).toEqual([]);
    });
  });

  describe("glob tool", () => {
    it("returns empty array (search tools are not tracked)", () => {
      const metadata = { pattern: "**/*.ts" };

      const result = extractFileChanges("glob", undefined, metadata);

      expect(result).toEqual([]);
    });
  });

  describe("grep tool", () => {
    it("returns empty array (search tools are not tracked)", () => {
      const metadata = { pattern: "TODO" };

      const result = extractFileChanges("grep", undefined, metadata);

      expect(result).toEqual([]);
    });
  });

  describe("codesearch tool", () => {
    it("returns empty array (search tools are not tracked)", () => {
      const metadata = { query: "function" };

      const result = extractFileChanges("codesearch", undefined, metadata);

      expect(result).toEqual([]);
    });
  });

  describe("bash/shell tool", () => {
    it("returns empty array (shell commands are not tracked)", () => {
      const metadata = { command: "npm install" };

      const result = extractFileChanges("shell", undefined, metadata);

      expect(result).toEqual([]);
    });
  });

  describe("unknown tool", () => {
    it("returns empty array for unknown tools", () => {
      const metadata = { some: "data" };

      const result = extractFileChanges("unknown-tool", undefined, metadata);

      expect(result).toEqual([]);
    });
  });
});
