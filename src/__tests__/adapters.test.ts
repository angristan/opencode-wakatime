import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createState } from "../state.js";
import { v1Plugin } from "../v1.js";
import { setupV2 } from "../v2.js";
import type { V2Context, V2Event, V2ToolEvent } from "../v2-api.js";
import {
  ensureCliInstalled,
  flushHeartbeats,
  sendHeartbeats,
} from "../wakatime.js";

vi.mock("../wakatime.js", () => ({
  ensureCliInstalled: vi.fn(async () => true),
  sendHeartbeats: vi.fn(async () => {}),
  flushHeartbeats: vi.fn(async () => {}),
}));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), setLevel: vi.fn() },
  LogLevel: { DEBUG: 0 },
}));

let home: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.clearAllMocks();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-adapter-"));
  vi.stubEnv("WAKATIME_HOME", home);
  vi.stubEnv("OPENCODE_CLIENT", "app");
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function v2Host(directory = "/project/a") {
  let toolHook: (event: V2ToolEvent) => Promise<void>;
  let promptHook: (event: { sessionID: string }) => Promise<void>;
  let wake: (() => void) | undefined;
  let aborted = false;
  let consumed = 0;
  const events: V2Event[] = [];
  const locations = new Map<string, string>();
  const ctx: V2Context = {
    app: { version: "2.0.18" },
    location: { directory, project: { directory } },
    tool: {
      hook: async (_name, callback) => {
        toolHook = callback;
        return { dispose: async () => {} };
      },
    },
    session: {
      get: async ({ sessionID }) => ({
        location: { directory: locations.get(sessionID) ?? directory },
      }),
      hook: async (_name, callback) => {
        promptHook = callback;
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: async function* ({ signal }) {
        const onAbort = () => {
          aborted = true;
          wake?.();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          while (!signal.aborted) {
            const event = events.shift();
            if (event) {
              yield event;
              consumed++;
            } else
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
          }
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },
    },
  };
  return {
    ctx,
    locations,
    get aborted() {
      return aborted;
    },
    get consumed() {
      return consumed;
    },
    execute: (event: V2ToolEvent) => toolHook(event),
    prompt: (sessionID: string) => promptHook({ sessionID }),
    emit(event: V2Event) {
      events.push(event);
      wake?.();
    },
  };
}

function edit(sessionID = "s1", id = "call1", file = "src/a.ts"): V2ToolEvent {
  return {
    sessionID,
    id,
    tool: "edit",
    input: { path: file },
    status: "completed",
    result: {
      output: {
        files: [{ file, additions: 7, deletions: 2, status: "modified" }],
      },
    },
  };
}

function heartbeats() {
  return vi.mocked(sendHeartbeats).mock.calls.flatMap(([batch]) => batch);
}

async function startV2(host = v2Host()) {
  const cleanup = await setupV2(host.ctx);
  cleanups.push(cleanup);
  return host;
}

async function startV1(directory = "/project/v1") {
  const hooks = await v1Plugin({
    directory,
    worktree: directory,
    project: { worktree: directory },
    client: {
      global: {
        _client: { get: async () => ({ data: { version: "1.1.53" } }) },
      },
    },
  } as unknown as Parameters<Plugin>[0]);
  const disposable = hooks as Hooks & { dispose: () => Promise<void> };
  cleanups.push(disposable.dispose);
  return disposable;
}

async function v1Event(hooks: Hooks, event: unknown) {
  await hooks.event?.({ event } as Parameters<NonNullable<Hooks["event"]>>[0]);
}

function v1Edit(callID = "call1", sessionID = "s1", tool = "edit") {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        sessionID,
        callID,
        tool,
        state: {
          status: "completed",
          title: "src/a.ts",
          output: "done",
          metadata: {
            filediff: { file: "src/a.ts", additions: 7, deletions: 2 },
          },
        },
      },
    },
  };
}

describe("v1 adapter", () => {
  it("tracks completed tool parts once, including batch child events", async () => {
    const hooks = await startV1();
    await v1Event(hooks, v1Edit("batch", "s1", "batch"));
    await v1Event(hooks, v1Edit());
    await v1Event(hooks, v1Edit());
    await hooks.dispose();
    expect(heartbeats()).toEqual([
      expect.objectContaining({
        entity: "/project/v1/src/a.ts",
        projectFolder: "/project/v1",
        lineChanges: 5,
        category: "ai coding",
        opencodeVersion: "1.1.53",
        opencodeClient: "web",
      }),
    ]);
  });

  it.each([
    "session.idle",
    "session.deleted",
  ])("flushes rate-limited changes on %s", async (type) => {
    const hooks = await startV1();
    createState("/project/v1").updateLastHeartbeat();
    await v1Event(hooks, v1Edit());
    expect(heartbeats()).toEqual([]);
    await v1Event(hooks, {
      type,
      properties:
        type === "session.idle" ? { sessionID: "s1" } : { info: { id: "s1" } },
    });
    expect(heartbeats()).toHaveLength(1);
  });

  it("ignores running tool updates", async () => {
    const hooks = await startV1();
    const event = v1Edit();
    event.properties.part.state.status = "running";
    await v1Event(hooks, event);
    await hooks.dispose();
    expect(heartbeats()).toEqual([]);
  });
});

describe("v2 adapter", () => {
  it("tracks successful results once with v2 version and resolved paths", async () => {
    const host = await startV2();
    await host.execute(edit());
    await host.execute(edit());
    await cleanups[0]();
    expect(heartbeats()).toEqual([
      expect.objectContaining({
        entity: "/project/a/src/a.ts",
        projectFolder: "/project/a",
        lineChanges: 5,
        opencodeVersion: "2.0.18",
        opencodeClient: "web",
      }),
    ]);
  });

  it("keeps the v2 tool hook open until heartbeat delivery finishes", async () => {
    const host = await startV2();
    let finishDelivery!: () => void;
    const delivery = new Promise<undefined>((resolve) => {
      finishDelivery = () => resolve(undefined);
    });
    vi.mocked(sendHeartbeats).mockReturnValueOnce(delivery);
    let returned = false;
    const execution = host.execute(edit()).then(() => {
      returned = true;
    });
    try {
      await vi.waitFor(() => expect(sendHeartbeats).toHaveBeenCalledOnce());
      expect(returned).toBe(false);
    } finally {
      finishDelivery();
      await execution;
    }
    expect(returned).toBe(true);
  });

  it("retries an interrupted heartbeat once during cleanup", async () => {
    const host = await startV2();
    vi.mocked(sendHeartbeats).mockResolvedValueOnce("interrupted");
    await host.execute(edit());
    expect(heartbeats()).toHaveLength(1);
    await cleanups[0]();
    expect(heartbeats()).toHaveLength(2);
    expect(heartbeats()[1]).toEqual(heartbeats()[0]);
    await cleanups[0]();
    expect(heartbeats()).toHaveLength(2);
  });

  it("ignores failures, directories, and other locations", async () => {
    const host = await startV2();
    host.locations.set("other", "/project/b");
    await host.execute({ ...edit(), status: "error", result: undefined });
    await host.execute({
      ...edit(),
      tool: "read",
      result: { output: { type: "list-page" } },
    });
    await host.execute(edit("other"));
    await cleanups[0]();
    expect(heartbeats()).toEqual([]);
  });

  it("keeps project state and identical call IDs independent", async () => {
    const a = await startV2(v2Host("/project/a"));
    const b = await startV2(v2Host("/project/b"));
    await a.execute(edit());
    await b.execute(edit());
    await a.execute(edit("s1", "call2", "src/second.ts"));
    expect(heartbeats().map((item) => item.entity)).toEqual([
      "/project/a/src/a.ts",
      "/project/b/src/a.ts",
    ]);
    await cleanups[0]();
    expect(heartbeats().at(-1)).toMatchObject({
      entity: "/project/a/src/second.ts",
      projectFolder: "/project/a",
    });
  });

  it("flushes only the matching session on idle and deletion", async () => {
    const host = await startV2();
    createState("/project/a").updateLastHeartbeat();
    await host.execute(edit("s1", "shared", "one.ts"));
    await host.execute(edit("s2", "shared", "two.ts"));
    host.emit({
      type: "session.status",
      data: { sessionID: "s1", status: { type: "idle" } },
      location: { directory: "/project/b" },
    });
    host.emit({
      type: "session.status",
      data: { sessionID: "s1", status: { type: "busy" } },
      location: { directory: "/project/a" },
    });
    await vi.waitFor(() => expect(host.consumed).toBe(2));
    expect(heartbeats()).toEqual([]);
    host.emit({
      type: "session.status",
      data: { sessionID: "s1", status: { type: "idle" } },
      location: { directory: "/project/a" },
    });
    await vi.waitFor(() => expect(heartbeats()).toHaveLength(1));
    expect(heartbeats()[0].entity).toBe("/project/a/one.ts");
    host.emit({ type: "session.deleted", data: { sessionID: "s2" } });
    await vi.waitFor(() => expect(heartbeats()).toHaveLength(2));
    expect(heartbeats()[1].entity).toBe("/project/a/two.ts");
  });

  it.each([
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
  ])("flushes queued changes on %s without waiting for shutdown", async (type) => {
    const host = await startV2();
    createState("/project/a").updateLastHeartbeat();
    await host.execute(edit());
    expect(heartbeats()).toEqual([]);
    host.emit({ type, data: { sessionID: "s1" } });
    await vi.waitFor(() => expect(heartbeats()).toHaveLength(1));
    expect(host.aborted).toBe(false);
  });

  it("processes queued activity on prompt after the rate limit expires", async () => {
    const host = await startV2();
    const state = createState("/project/a");
    state.updateLastHeartbeat();
    await host.execute(edit());
    expect(heartbeats()).toEqual([]);
    state.writeState({ lastHeartbeatAt: 0 });
    await host.prompt("s1");
    expect(heartbeats()).toHaveLength(1);
  });

  it("stops the subscription and awaits final heartbeats on cleanup", async () => {
    const host = await startV2();
    createState("/project/a").updateLastHeartbeat();
    await host.execute(edit());
    let finish!: () => void;
    vi.mocked(flushHeartbeats).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let finished = false;
    const stopping = cleanups[0]().then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(heartbeats()).toHaveLength(1));
    expect(host.aborted).toBe(true);
    expect(finished).toBe(false);
    finish();
    await stopping;
    await host.execute(edit("s1", "after-cleanup"));
    expect(heartbeats()).toHaveLength(1);
  });

  it("reconnects after an event stream failure and still flushes", async () => {
    const host = v2Host();
    const subscribe = host.ctx.event.subscribe;
    let attempts = 0;
    host.ctx.event.subscribe = (options) => {
      attempts++;
      if (attempts === 1) throw new Error("disconnected");
      return subscribe(options);
    };
    await startV2(host);
    createState("/project/a").updateLastHeartbeat();
    await host.execute(edit());
    await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 2000 });
    host.emit({
      type: "session.status",
      data: { sessionID: "s1", status: { type: "idle" } },
    });
    await vi.waitFor(() => expect(heartbeats()).toHaveLength(1));
  });

  it("does not fail the tool when the session lookup fails", async () => {
    const host = await startV2();
    host.ctx.session.get = async () => {
      throw new Error("session unavailable");
    };
    await expect(host.execute(edit())).resolves.toBeUndefined();
    expect(heartbeats()).toEqual([]);
  });

  it("still initializes if the CLI is unavailable", async () => {
    vi.mocked(ensureCliInstalled).mockResolvedValueOnce(false);
    const host = await startV2();
    await host.execute(edit());
    expect(heartbeats()).toHaveLength(1);
  });
});
