import { describe, expect, it } from "vitest";
import { extractV2FileChanges } from "../file-changes.js";

// Result shapes from @opencode/plugin 2.0.18's built-in tools.
describe("v2 file results", () => {
  it.each([
    "edit",
    "patch",
  ])("uses per-file counts for %s, including paths with spaces", (tool) => {
    expect(
      extractV2FileChanges(
        tool,
        {},
        {
          output: {
            files: [
              {
                file: "src/a file.ts",
                additions: 7,
                deletions: 2,
                status: "modified",
              },
              {
                file: "src/new.ts",
                additions: 3,
                deletions: 0,
                status: "added",
              },
              {
                file: "src/old.ts",
                additions: 0,
                deletions: 8,
                status: "deleted",
              },
            ],
          },
          content: "Do not parse this text for file names",
        },
      ),
    ).toEqual([
      {
        file: "src/a file.ts",
        info: { additions: 7, deletions: 2, isWrite: false },
      },
      {
        file: "src/new.ts",
        info: { additions: 3, deletions: 0, isWrite: true },
      },
      {
        file: "src/old.ts",
        info: { additions: 0, deletions: 8, isWrite: false },
      },
    ]);
  });

  it("does not count output and metadata copies of a diff twice", () => {
    const files = [{ file: "a.ts", additions: 2, deletions: 1 }];
    expect(
      extractV2FileChanges(
        "edit",
        {},
        { output: { files }, metadata: { files } },
      ),
    ).toHaveLength(1);
    expect(
      extractV2FileChanges("edit", {}, { metadata: { files } }),
    ).toHaveLength(1);
  });

  it.each([
    true,
    false,
  ])("reads write target and existed=%s without v1 metadata", (existed) => {
    expect(
      extractV2FileChanges(
        "write",
        { path: "wrong.ts" },
        {
          output: {
            operation: "write",
            target: "/project/new.ts",
            resource: "new.ts",
            existed,
          },
          content: "Created file successfully",
        },
      ),
    ).toEqual([
      {
        file: "/project/new.ts",
        info: { additions: 0, deletions: 0, isWrite: !existed },
      },
    ]);
  });

  it.each(["text-page", "file"])("tracks a %s read from input.path", (type) => {
    expect(
      extractV2FileChanges("read", { path: "src/a.ts" }, { output: { type } }),
    ).toEqual([
      {
        file: "src/a.ts",
        info: { additions: 0, deletions: 0, isWrite: false },
      },
    ]);
  });

  it("ignores directory reads even without local filesystem access", () => {
    expect(
      extractV2FileChanges(
        "read",
        { path: "src" },
        { output: { type: "list-page", entries: [] } },
      ),
    ).toEqual([]);
  });

  it("ignores unrelated tools and malformed changes", () => {
    expect(extractV2FileChanges("shell", { path: "src/a.ts" }, {})).toEqual([]);
    expect(
      extractV2FileChanges(
        "edit",
        {},
        { output: { files: [null, {}, { file: 4 }] } },
      ),
    ).toEqual([]);
    expect(extractV2FileChanges("write", {}, null)).toEqual([]);
    expect(extractV2FileChanges("read", {}, {})).toEqual([]);
  });
});
