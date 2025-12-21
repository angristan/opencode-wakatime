import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LOG_FILE = path.join(os.homedir(), ".wakatime", "opencode.log");

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
      const dir = path.dirname(LOG_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(LOG_FILE, line);
    } catch {
      // Silently ignore logging errors
    }
  }
}

export const logger = new Logger();
