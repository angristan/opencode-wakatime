import * as fs from "node:fs";
import * as path from "node:path";
import { getWakatimeResourcesDir } from "./wakatime-paths.js";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

function getLogFilePath(): string {
  return path.join(getWakatimeResourcesDir(), "opencode.log");
}

export class Logger {
  private level: LogLevel = LogLevel.INFO;

  setLevel(level: LogLevel) {
    this.level = level;
  }

  debug(msg: string) {
    this.log(LogLevel.DEBUG, msg);
  }

  info(msg: string) {
    this.log(LogLevel.INFO, msg);
  }

  warn(msg: string) {
    this.log(LogLevel.WARN, msg);
  }

  error(msg: string) {
    this.log(LogLevel.ERROR, msg);
  }

  warnException(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    this.warn(message);
  }

  errorException(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    this.error(message);
  }

  private log(level: LogLevel, msg: string) {
    if (level < this.level) return;

    const levelName = LogLevel[level];
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}][${levelName}] ${msg}\n`;

    try {
      const logFile = getLogFilePath();
      const dir = path.dirname(logFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(logFile, line);
    } catch {
      // Silently ignore logging errors
    }
  }
}

export const logger = new Logger();
