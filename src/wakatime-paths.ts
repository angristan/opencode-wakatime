import * as os from "node:os";
import * as path from "node:path";

function getWakatimeHomeFromEnv(): string | undefined {
  const value = process.env.WAKATIME_HOME?.trim();
  if (!value) {
    return undefined;
  }

  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

export function getWakatimeHomeDir(): string {
  return getWakatimeHomeFromEnv() ?? os.homedir();
}

export function getWakatimeResourcesDir(): string {
  const wakatimeHome = getWakatimeHomeFromEnv();
  if (wakatimeHome) {
    return wakatimeHome;
  }

  return path.join(os.homedir(), ".wakatime");
}

export function getWakatimeConfigFilePath(): string {
  return path.join(getWakatimeHomeDir(), ".wakatime.cfg");
}
