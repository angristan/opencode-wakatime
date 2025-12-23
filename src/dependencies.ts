import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { createWriteStream } from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "./logger.js";

function whichSync(cmd: string): string | null {
  try {
    const isWindows = os.platform() === "win32";
    const result = execSync(isWindows ? `where ${cmd}` : `which ${cmd}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const firstLine = result.trim().split("\n")[0];
    return firstLine || null;
  } catch {
    return null;
  }
}

const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/wakatime/wakatime-cli/releases/latest";
const GITHUB_DOWNLOAD_URL =
  "https://github.com/wakatime/wakatime-cli/releases/latest/download";

// Check interval for updates (4 hours)
const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000;

interface CliState {
  lastChecked?: number;
  version?: string;
}

export class Dependencies {
  private resourcesLocation: string;
  private cliLocation?: string;
  private stateFile: string;

  constructor() {
    this.resourcesLocation = path.join(os.homedir(), ".wakatime");
    this.stateFile = path.join(
      this.resourcesLocation,
      "opencode-cli-state.json",
    );
  }

  private isWindows(): boolean {
    return os.platform() === "win32";
  }

  private getOsName(): string {
    const platform = os.platform();
    if (platform === "win32") return "windows";
    return platform;
  }

  private getArchitecture(): string {
    const arch = os.arch();
    if (arch === "x64") return "amd64";
    if (arch === "ia32" || arch.includes("32")) return "386";
    if (arch === "arm64") return "arm64";
    if (arch === "arm") return "arm";
    return arch;
  }

  private getCliBinaryName(): string {
    const osname = this.getOsName();
    const arch = this.getArchitecture();
    const ext = this.isWindows() ? ".exe" : "";
    return `wakatime-cli-${osname}-${arch}${ext}`;
  }

  private getCliDownloadUrl(): string {
    const osname = this.getOsName();
    const arch = this.getArchitecture();
    return `${GITHUB_DOWNLOAD_URL}/wakatime-cli-${osname}-${arch}.zip`;
  }

  private readState(): CliState {
    try {
      if (fs.existsSync(this.stateFile)) {
        return JSON.parse(fs.readFileSync(this.stateFile, "utf-8"));
      }
    } catch {
      // Ignore errors
    }
    return {};
  }

  private writeState(state: CliState): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch {
      // Ignore errors
    }
  }

  public getCliLocationGlobal(): string | undefined {
    const binaryName = `wakatime-cli${this.isWindows() ? ".exe" : ""}`;
    try {
      const globalPath = whichSync(binaryName);
      if (globalPath) {
        logger.debug(`Found global wakatime-cli: ${globalPath}`);
        return globalPath;
      }
    } catch {
      // Ignore errors
    }
    return undefined;
  }

  public getCliLocation(): string {
    if (this.cliLocation) return this.cliLocation;

    // Check for global installation first
    const globalCli = this.getCliLocationGlobal();
    if (globalCli) {
      this.cliLocation = globalCli;
      return this.cliLocation;
    }

    // Fall back to local installation
    const binary = this.getCliBinaryName();
    this.cliLocation = path.join(this.resourcesLocation, binary);
    return this.cliLocation;
  }

  public isCliInstalled(): boolean {
    const location = this.getCliLocation();
    return fs.existsSync(location);
  }

  private shouldCheckForUpdates(): boolean {
    // Don't check updates for global installations
    if (this.getCliLocationGlobal()) {
      return false;
    }

    const state = this.readState();
    if (!state.lastChecked) return true;

    return Date.now() - state.lastChecked > UPDATE_CHECK_INTERVAL;
  }

  public async checkAndInstallCli(): Promise<void> {
    // If using global CLI, skip installation
    if (this.getCliLocationGlobal()) {
      logger.debug("Using global wakatime-cli, skipping installation check");
      return;
    }

    if (!this.isCliInstalled()) {
      logger.info("wakatime-cli not found, downloading...");
      await this.installCli();
      return;
    }

    if (this.shouldCheckForUpdates()) {
      logger.debug("Checking for wakatime-cli updates...");
      const latestVersion = await this.getLatestVersion();
      const state = this.readState();

      if (latestVersion && latestVersion !== state.version) {
        logger.info(`Updating wakatime-cli to ${latestVersion}...`);
        await this.installCli();
        this.writeState({ lastChecked: Date.now(), version: latestVersion });
      } else {
        this.writeState({ ...state, lastChecked: Date.now() });
      }
    }
  }

  private async getLatestVersion(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const options = {
        headers: {
          "User-Agent": "opencode-wakatime",
        },
      };

      https
        .get(GITHUB_RELEASES_URL, options, (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              resolve(json.tag_name);
            } catch {
              resolve(undefined);
            }
          });
        })
        .on("error", () => {
          resolve(undefined);
        });
    });
  }

  private async installCli(): Promise<void> {
    const zipUrl = this.getCliDownloadUrl();
    const zipFile = path.join(
      this.resourcesLocation,
      `wakatime-cli-${Date.now()}.zip`,
    );

    try {
      // Ensure directory exists
      fs.mkdirSync(this.resourcesLocation, { recursive: true });

      // Download the zip file
      logger.debug(`Downloading wakatime-cli from ${zipUrl}`);
      await this.downloadFile(zipUrl, zipFile);

      // Extract the zip file
      logger.debug(`Extracting wakatime-cli to ${this.resourcesLocation}`);
      await this.extractZip(zipFile, this.resourcesLocation);

      // Set executable permission on Unix
      if (!this.isWindows()) {
        const cliPath = this.getCliLocation();
        if (fs.existsSync(cliPath)) {
          fs.chmodSync(cliPath, 0o755);
          logger.debug(`Set executable permission on ${cliPath}`);
        }
      }

      logger.info("wakatime-cli installed successfully");
    } catch (err) {
      logger.errorException(err);
      throw err;
    } finally {
      // Clean up zip file
      try {
        if (fs.existsSync(zipFile)) {
          fs.unlinkSync(zipFile);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const followRedirect = (url: string, redirectCount = 0): void => {
        if (redirectCount > 5) {
          reject(new Error("Too many redirects"));
          return;
        }

        https
          .get(url, (res) => {
            // Handle redirects
            if (res.statusCode === 301 || res.statusCode === 302) {
              const location = res.headers.location;
              if (location) {
                followRedirect(location, redirectCount + 1);
                return;
              }
            }

            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }

            const file = createWriteStream(dest);
            res.pipe(file);
            file.on("finish", () => {
              file.close();
              resolve();
            });
            file.on("error", (err) => {
              fs.unlinkSync(dest);
              reject(err);
            });
          })
          .on("error", reject);
      };

      followRedirect(url);
    });
  }

  private async extractZip(zipFile: string, destDir: string): Promise<void> {
    // Use native unzip command if available, otherwise fall back to manual extraction
    const { execSync } = await import("node:child_process");

    try {
      if (this.isWindows()) {
        // Use PowerShell on Windows
        execSync(
          `powershell -command "Expand-Archive -Force '${zipFile}' '${destDir}'"`,
          {
            windowsHide: true,
          },
        );
      } else {
        // Use unzip on Unix
        execSync(`unzip -o "${zipFile}" -d "${destDir}"`, {
          stdio: "ignore",
        });
      }
    } catch (_err) {
      logger.warn("Native unzip failed, attempting manual extraction");
      await this.extractZipManual(zipFile, destDir);
    }
  }

  private async extractZipManual(
    zipFile: string,
    destDir: string,
  ): Promise<void> {
    // Simple ZIP extraction for single-file archives
    // This is a fallback and handles the simple case of wakatime-cli zips

    // Read the zip file and find the binary
    const data = fs.readFileSync(zipFile);

    // Find local file header signature (0x04034b50)
    let offset = 0;
    while (offset < data.length - 4) {
      if (
        data[offset] === 0x50 &&
        data[offset + 1] === 0x4b &&
        data[offset + 2] === 0x03 &&
        data[offset + 3] === 0x04
      ) {
        // Parse local file header
        const compressedSize = data.readUInt32LE(offset + 18);
        const uncompressedSize = data.readUInt32LE(offset + 22);
        const fileNameLength = data.readUInt16LE(offset + 26);
        const extraFieldLength = data.readUInt16LE(offset + 28);
        const fileName = data
          .slice(offset + 30, offset + 30 + fileNameLength)
          .toString();

        const dataStart = offset + 30 + fileNameLength + extraFieldLength;
        const compressionMethod = data.readUInt16LE(offset + 8);

        if (fileName.includes("wakatime-cli")) {
          const destPath = path.join(destDir, path.basename(fileName));

          if (compressionMethod === 0) {
            // Stored (no compression)
            const fileData = data.slice(
              dataStart,
              dataStart + uncompressedSize,
            );
            fs.writeFileSync(destPath, fileData);
          } else if (compressionMethod === 8) {
            // Deflate - use zlib
            const { inflateRawSync } = await import("node:zlib");
            const compressedData = data.slice(
              dataStart,
              dataStart + compressedSize,
            );
            const decompressed = inflateRawSync(compressedData);
            fs.writeFileSync(destPath, decompressed);
          }

          logger.debug(`Extracted ${fileName} to ${destPath}`);
          return;
        }

        offset = dataStart + compressedSize;
      } else {
        offset++;
      }
    }

    throw new Error("Could not find wakatime-cli in zip file");
  }
}

// Singleton instance
export const dependencies = new Dependencies();
