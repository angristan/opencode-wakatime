// Only the Promise API used by this plugin is described here. Keeping this
// boundary structural avoids loading the v2 SDK (and Effect) in v1 or bundles.
// Contract: anomalyco/opencode@c33de198e3b7ebd205d93bad4cb7b070f5442bff,
// packages/plugin/src/promise/{plugin,tool,session,event}.ts (@opencode/plugin 2.0.18).
export interface V2Location {
  readonly directory: string;
}

export interface V2Event {
  readonly type: string;
  readonly location?: V2Location;
  readonly data: {
    readonly sessionID?: string;
    readonly status?: { readonly type: string };
  };
}

export interface V2ToolEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly id: string;
  readonly input: unknown;
  readonly status: "completed" | "error";
  readonly result?: unknown;
}

export interface Registration {
  dispose(): Promise<void>;
}

export interface V2Context {
  readonly app: { readonly version: string };
  readonly location: V2Location & {
    readonly project: { readonly directory: string };
  };
  readonly tool: {
    hook(
      name: "execute.after",
      callback: (event: V2ToolEvent) => Promise<void>,
    ): Promise<Registration>;
  };
  readonly session: {
    get(input: {
      sessionID: string;
    }): Promise<{ readonly location: V2Location }>;
    hook(
      name: "prompt",
      callback: (event: { readonly sessionID: string }) => Promise<void>,
    ): Promise<Registration>;
  };
  readonly event: {
    subscribe(options: { signal: AbortSignal }): AsyncIterable<V2Event>;
  };
}
