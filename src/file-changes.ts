export interface FileChangeInfo {
  additions: number;
  deletions: number;
  isWrite: boolean;
}

export interface FileChange {
  file: string;
  info: Partial<FileChangeInfo>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function fileChange(
  file: unknown,
  additions = 0,
  deletions = 0,
  isWrite = false,
): FileChange[] {
  return typeof file === "string" && file.length > 0
    ? [{ file, info: { additions, deletions, isWrite } }]
    : [];
}

function diffChange(value: unknown): FileChange[] {
  const diff = record(value);
  return diff
    ? fileChange(
        diff.file,
        count(diff.additions),
        count(diff.deletions),
        diff.status === "added",
      )
    : [];
}

/** Normalize v1 tool metadata without depending on the SDK at runtime. */
export function extractFileChanges(
  tool: string,
  metadata: Record<string, unknown> | undefined,
  output: string,
  title?: string,
): FileChange[] {
  if (!metadata) return [];
  switch (tool) {
    case "edit": {
      const diff = diffChange(metadata.filediff);
      return diff.length > 0 ? diff : fileChange(metadata.filePath);
    }
    case "write":
      return fileChange(metadata.filepath, 0, 0, !metadata.exists);
    case "patch": {
      const files = output
        .split("\n")
        .filter((line) => line.startsWith("  ") && !line.startsWith("   "))
        .map((line) => line.trim())
        .filter((file) => file && !file.includes(" "));
      const diff =
        files.length > 0 ? Math.round(count(metadata.diff) / files.length) : 0;
      return files.flatMap((file) =>
        fileChange(file, Math.max(diff, 0), Math.max(-diff, 0)),
      );
    }
    case "multiedit":
      return Array.isArray(metadata.results)
        ? metadata.results.flatMap((result) =>
            diffChange(record(result)?.filediff),
          )
        : [];
    case "read":
      return fileChange(title);
    default:
      return [];
  }
}

/** V2 results use structured output, not v1's title and output string. */
export function extractV2FileChanges(
  tool: string,
  input: unknown,
  result: unknown,
): FileChange[] {
  const value = record(result);
  const output = record(value?.output);
  switch (tool) {
    case "edit":
    case "patch": {
      const files = output?.files ?? record(value?.metadata)?.files;
      return Array.isArray(files) ? files.flatMap(diffChange) : [];
    }
    case "write":
      return fileChange(
        output?.target ?? output?.resource,
        0,
        0,
        output?.existed === false,
      );
    case "read":
      return output?.type === "list-page"
        ? []
        : fileChange(record(input)?.path);
    default:
      return [];
  }
}
