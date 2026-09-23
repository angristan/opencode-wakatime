/**
 * OpenCode 2 plugin surface we actually call.
 *
 * Structural on purpose: `@opencode/plugin` and the V1 `@opencode-ai/plugin`
 * cannot share a module graph, and `Plugin.define` is an identity function.
 * Exporting `{ id, setup }` is the 2.0 contract.
 */

export type Cleanup = () => Promise<void> | void;

export type Registration = {
  dispose: () => Promise<void>;
};

export type OpenCodeApp = {
  name?: string;
  version?: string;
  channel?: string;
};

export type OpenCodeLocation = {
  directory?: string;
  project?: {
    id?: string;
    directory?: string;
    canonical?: string;
  };
};

export type OpenCodeEvent = {
  type: string;
  properties?: unknown;
};

export type ToolExecuteAfter = {
  tool: string;
  sessionID?: string;
  /** Official 2.0.14 field. */
  id?: string;
  /** Beta hosts used by some internal plugins. */
  callID?: string;
  input?: unknown;
  status?: string;
  result?: unknown;
};

export type PluginContext = {
  app?: OpenCodeApp;
  location?: OpenCodeLocation;
  options?: Readonly<Record<string, unknown>>;
  event?: {
    subscribe?: (options?: {
      signal?: AbortSignal;
    }) => AsyncIterable<OpenCodeEvent> | Promise<AsyncIterable<OpenCodeEvent>>;
  };
  session?: {
    hook?: (
      name: "prompt",
      callback: (event: { sessionID?: string }) => Promise<void> | void,
    ) => Promise<Registration> | Registration;
    get?: (input: {
      sessionID: string;
    }) => Promise<{ location?: { directory?: string } }>;
  };
  tool?: {
    hook?: (
      name: "execute.after",
      callback: (event: ToolExecuteAfter) => Promise<void> | void,
    ) => Promise<Registration> | Registration;
  };
};

export type PluginDefinition = {
  id: string;
  setup: (
    ctx: PluginContext,
  ) => Promise<Cleanup | undefined> | Cleanup | undefined;
  server?: () => Promise<Record<string, never>>;
};

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function firstString(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function detectOpenCodeClient(app?: OpenCodeApp): string {
  const raw = process.env.OPENCODE_CLIENT || app?.channel || app?.name || "cli";
  return raw === "app" ? "web" : raw;
}

export function resolveOpenCode2ProjectFolder(input: {
  sessionDirectory?: string;
  locationDirectory?: string;
  projectDirectory?: string;
  projectCanonical?: string;
  cwd?: string;
}): string {
  return (
    input.sessionDirectory ||
    input.locationDirectory ||
    input.projectDirectory ||
    input.projectCanonical ||
    input.cwd ||
    process.cwd()
  );
}

export function toolCallId(event: {
  id?: string;
  callID?: string;
}): string | undefined {
  return event.id || event.callID;
}

const TOOL_ALIASES: Record<string, string> = {
  apply_patch: "patch",
  applypatch: "patch",
  multi_edit: "multiedit",
  read_file: "read",
  search_replace: "edit",
  str_replace: "edit",
  write_file: "write",
};

export function normalizeToolName(tool: string): string {
  return TOOL_ALIASES[tool] ?? tool;
}
