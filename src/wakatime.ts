import { execFile, type ExecFileOptions } from "child_process"
import * as os from "os"
import { logger } from "./logger.js"
import { dependencies } from "./dependencies.js"

const VERSION = "1.0.0"

export interface HeartbeatParams {
  entity: string
  projectFolder?: string
  lineChanges?: number
  category?: string
  isWrite?: boolean
}

function isWindows(): boolean {
  return os.platform() === "win32"
}

function buildExecOptions(): ExecFileOptions {
  const options: ExecFileOptions = {
    windowsHide: true,
  }

  if (!isWindows() && !process.env.WAKATIME_HOME && !process.env.HOME) {
    options.env = { ...process.env, WAKATIME_HOME: os.homedir() }
  }

  return options
}

function formatArgs(args: string[]): string {
  return args
    .map((arg) => {
      if (arg.includes(" ")) {
        return `"${arg.replace(/"/g, '\\"')}"`
      }
      return arg
    })
    .join(" ")
}

export async function ensureCliInstalled(): Promise<boolean> {
  try {
    await dependencies.checkAndInstallCli()
    return dependencies.isCliInstalled()
  } catch (err) {
    logger.errorException(err)
    return false
  }
}

export function sendHeartbeat(params: HeartbeatParams): void {
  const cliLocation = dependencies.getCliLocation()

  if (!dependencies.isCliInstalled()) {
    logger.warn("wakatime-cli not installed, skipping heartbeat")
    return
  }

  const args: string[] = [
    "--entity",
    params.entity,
    "--entity-type",
    "file",
    "--category",
    params.category ?? "ai coding",
    "--plugin",
    `opencode/1.0.0 opencode-wakatime/${VERSION}`,
  ]

  if (params.projectFolder) {
    args.push("--project-folder", params.projectFolder)
  }

  if (params.lineChanges !== undefined && params.lineChanges !== 0) {
    args.push("--ai-line-changes", params.lineChanges.toString())
  }

  if (params.isWrite) {
    args.push("--write")
  }

  logger.debug(`Sending heartbeat: wakatime-cli ${formatArgs(args)}`)

  const execOptions = buildExecOptions()
  execFile(cliLocation, args, execOptions, (error, stdout, stderr) => {
    const output = (stdout?.toString().trim() ?? "") + (stderr?.toString().trim() ?? "")
    if (output) {
      logger.debug(`wakatime-cli output: ${output}`)
    }
    if (error) {
      logger.error(`wakatime-cli error: ${error.message}`)
    }
  })
}

export function isCliAvailable(): boolean {
  return dependencies.isCliInstalled() || dependencies.getCliLocationGlobal() !== undefined
}
