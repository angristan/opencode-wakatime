import * as fs from "node:fs";
import * as path from "node:path";
import {
  getWakatimeConfigFilePath,
  getWakatimeResourcesDir,
} from "./wakatime-paths.js";

export const HUD_CACHE_TTL_MS = 60_000;

const STATUS_BAR_URL =
  "https://api.wakatime.com/api/v1/users/current/status_bar/today";

export type WakatimeHudCache = {
  fetchedAt: number;
  data: unknown;
};

export type WakatimePanelState = {
  status: "ready" | "missing-config" | "unavailable" | "loading";
  lines: string[];
};

type TimeEntry = {
  name: string;
  text: string;
  totalSeconds: number;
};

export function getHudCacheFilePath(): string {
  return path.join(getWakatimeResourcesDir(), "opencode-hud-cache.json");
}

export function parseWakatimeApiKey(cfg: string): string | undefined {
  for (const line of cfg.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
      continue;

    const match = trimmed.match(/^api_key\s*=\s*(.+?)\s*$/);
    if (!match) continue;

    const value = match[1].trim().replace(/^['"]|['"]$/g, "");
    return value || undefined;
  }

  return undefined;
}

export function readWakatimeApiKey(): string | undefined {
  try {
    return parseWakatimeApiKey(
      fs.readFileSync(getWakatimeConfigFilePath(), "utf-8"),
    );
  } catch {
    return undefined;
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function getDataRecord(value: unknown): Record<string, unknown> | undefined {
  const record = getRecord(value);
  const data = getRecord(record?.data);
  return data ?? record;
}

function withFetchedAt(
  data: unknown,
  fetchedAt: number,
): Record<string, unknown> {
  return { ...(getRecord(data) ?? {}), fetchedAt };
}

function getText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function entryFromRecord(
  record: unknown,
  fallbackName: string,
): TimeEntry | undefined {
  const item = getRecord(record);
  if (!item) return undefined;

  const text =
    getText(item.text) ?? getText(item.digital) ?? getText(item.name);
  const totalSeconds = getSeconds(item.total_seconds);
  if (!text && totalSeconds <= 0) return undefined;

  return {
    name: getText(item.name) ?? fallbackName,
    text: text ?? formatDuration(totalSeconds),
    totalSeconds,
  };
}

function topEntries(
  data: Record<string, unknown>,
  key: string,
  limit: number,
): TimeEntry[] {
  const value = data[key];
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index) => entryFromRecord(item, `${key} ${index + 1}`))
    .filter((item): item is TimeEntry => Boolean(item))
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .slice(0, limit);
}

function isAiCoding(entry: TimeEntry): boolean {
  return entry.name.toLowerCase().replace(/\s+/g, " ") === "ai coding";
}

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.round(totalSeconds / 60);
  if (minutes <= 0) return "0 mins";

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours} hr${hours === 1 ? "" : "s"}`);
  if (remainingMinutes > 0 || parts.length === 0) {
    parts.push(`${remainingMinutes} min${remainingMinutes === 1 ? "" : "s"}`);
  }

  return parts.join(" ");
}

export function formatWakatimePanelLines(
  payload: unknown,
  now: number = Date.now(),
): string[] {
  const data = getDataRecord(payload);
  if (!data) return ["WakaTime unavailable"];

  const grandTotal = entryFromRecord(data.grand_total, "Today");
  const lines = [`Today: ${grandTotal?.text ?? "0 mins"}`];

  const projects = topEntries(data, "projects", 1);
  const categories = topEntries(data, "categories", 10);
  const languages = topEntries(data, "languages", 1);

  const ai = categories.find(isAiCoding);
  if (ai) {
    lines.push(`AI Coding: ${ai.text}`);
  }

  const project = projects[0];
  if (project) {
    lines.push(`${project.name}: ${project.text}`);
  }

  if (!ai && !project) {
    const fallback = categories[0] ?? languages[0];
    if (fallback) lines.push(`${fallback.name}: ${fallback.text}`);
  }

  const cachedAt = getSeconds(getRecord(payload)?.fetchedAt);
  if (cachedAt > 0) {
    lines.push(`Updated ${formatCacheAge(now - cachedAt)} ago`);
  }

  return lines;
}

export function formatCacheAge(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

export function readHudCache(
  now: number = Date.now(),
): WakatimeHudCache | undefined {
  try {
    const cache = JSON.parse(
      fs.readFileSync(getHudCacheFilePath(), "utf-8"),
    ) as WakatimeHudCache;
    if (
      typeof cache.fetchedAt !== "number" ||
      now - cache.fetchedAt > HUD_CACHE_TTL_MS
    ) {
      return undefined;
    }

    return cache;
  } catch {
    return undefined;
  }
}

export function writeHudCache(cache: WakatimeHudCache): void {
  try {
    fs.mkdirSync(path.dirname(getHudCacheFilePath()), { recursive: true });
    fs.writeFileSync(getHudCacheFilePath(), JSON.stringify(cache));
  } catch {
    // The sidebar can still render unavailable state when cache writes fail.
  }
}

export function buildWakatimeAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(apiKey).toString("base64")}`;
}

export async function fetchWakatimeStatusBar(apiKey: string): Promise<unknown> {
  const response = await fetch(STATUS_BAR_URL, {
    headers: {
      Authorization: buildWakatimeAuthHeader(apiKey),
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`WakaTime API returned ${response.status}`);
  }

  return response.json();
}

export async function loadWakatimePanelState(
  now: number = Date.now(),
): Promise<WakatimePanelState> {
  const cached = readHudCache(now);
  if (cached) {
    return {
      status: "ready",
      lines: formatWakatimePanelLines(
        withFetchedAt(cached.data, cached.fetchedAt),
        now,
      ),
    };
  }

  const apiKey = readWakatimeApiKey();
  if (!apiKey) {
    return {
      status: "missing-config",
      lines: ["No WakaTime API key", "Set api_key in .wakatime.cfg"],
    };
  }

  try {
    const data = await fetchWakatimeStatusBar(apiKey);
    const nextCache = { fetchedAt: now, data };
    writeHudCache(nextCache);
    return {
      status: "ready",
      lines: formatWakatimePanelLines(withFetchedAt(data, now), now),
    };
  } catch {
    return {
      status: "unavailable",
      lines: ["WakaTime unavailable", "Retrying in 60s"],
    };
  }
}
