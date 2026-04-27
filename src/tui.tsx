/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";
import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  loadWakatimePanelState,
  type WakatimePanelState,
} from "./tui-panel.js";

const id = "opencode-wakatime";
const SIDEBAR_ORDER = 170;
const REFRESH_INTERVAL_MS = 60_000;

function SidebarContentView(props: { api: TuiPluginApi; sessionID: string }) {
  const [panel, setPanel] = createSignal<WakatimePanelState>({
    status: "loading",
    lines: ["Loading WakaTime..."],
  });

  let disposed = false;
  let loadVersion = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const reload = () => {
    const currentVersion = ++loadVersion;
    void loadWakatimePanelState()
      .then((next) => {
        if (disposed || currentVersion !== loadVersion) return;
        setPanel(next);
      })
      .catch(() => {
        if (disposed || currentVersion !== loadVersion) return;
        setPanel({
          status: "unavailable",
          lines: ["WakaTime unavailable", "Retrying in 60s"],
        });
      });
  };

  const queueRefresh = (delay: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      reload();
    }, delay);
    timers.add(timer);
  };

  const scheduleRefresh = () => {
    queueRefresh(150);
    queueRefresh(600);
  };

  createEffect(() => {
    props.sessionID;
    reload();
  });

  const interval = setInterval(reload, REFRESH_INTERVAL_MS);
  const unsubscribers = [
    props.api.event.on("session.updated", (event) => {
      if (event.properties?.info?.id === props.sessionID) scheduleRefresh();
    }),
    props.api.event.on("message.updated", (event) => {
      if (event.properties?.info?.sessionID === props.sessionID)
        scheduleRefresh();
    }),
    props.api.event.on("tui.session.select", (event) => {
      if (event.properties?.sessionID === props.sessionID) scheduleRefresh();
    }),
  ];

  onCleanup(() => {
    disposed = true;
    clearInterval(interval);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const unsubscribe of unsubscribers) unsubscribe();
  });

  const color = () => {
    const theme = props.api.theme.current;
    if (panel().status === "ready") return theme.textMuted;
    if (panel().status === "missing-config") return theme.warning;
    if (panel().status === "unavailable") return theme.error;
    return theme.textMuted;
  };

  return (
    <box gap={0}>
      <text fg={props.api.theme.current.text}>
        <b>WakaTime</b>
      </text>
      <box gap={0}>
        {panel().lines.map((line) => (
          <text fg={color()} wrapMode="none">
            {line || " "}
          </text>
        ))}
      </box>
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        return <SidebarContentView api={api} sessionID={props.session_id} />;
      },
    },
  });
};

const pluginModule: TuiPluginModule & { id: string } = {
  id,
  tui,
};

export default pluginModule;
