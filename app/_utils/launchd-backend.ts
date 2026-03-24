import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, unlink, mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";

import { CronJob } from "./cronjob-utils";
import { SchedulerBackend } from "./scheduler-backend";
import { cronToLaunchd, LaunchdSchedule, CalendarInterval } from "./cron-to-launchd";
import { DATA_DIR } from "../_consts/file";
import {
  readJobMetadata,
  writeJobMetadata,
  deleteJobMetadata,
  listAllJobMetadata,
  JobMetadata,
} from "./jobs-metadata-utils";
import {
  unwrapCommand,
  isCommandWrapped,
  ensureWrapperScriptInData,
  ensureRunnerScriptInData,
} from "./wrapper-utils";

const execAsync = promisify(exec);

const PLIST_PREFIX = "com.cronmaster.job.";
const LAUNCH_AGENTS_DIR = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents"
);

function plistLabel(id: string): string {
  return `${PLIST_PREFIX}${id}`;
}

function plistPath(id: string): string {
  return path.join(LAUNCH_AGENTS_DIR, `${plistLabel(id)}.plist`);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function generateCalendarIntervalXml(
  intervals: CalendarInterval[]
): string {
  const entries = intervals.map((entry) => {
    const parts: string[] = [];
    if (entry.Month !== undefined) {
      parts.push(
        `            <key>Month</key><integer>${entry.Month}</integer>`
      );
    }
    if (entry.Day !== undefined) {
      parts.push(
        `            <key>Day</key><integer>${entry.Day}</integer>`
      );
    }
    if (entry.Weekday !== undefined) {
      parts.push(
        `            <key>Weekday</key><integer>${entry.Weekday}</integer>`
      );
    }
    if (entry.Hour !== undefined) {
      parts.push(
        `            <key>Hour</key><integer>${entry.Hour}</integer>`
      );
    }
    if (entry.Minute !== undefined) {
      parts.push(
        `            <key>Minute</key><integer>${entry.Minute}</integer>`
      );
    }
    return `        <dict>\n${parts.join("\n")}\n        </dict>`;
  });

  return `    <key>StartCalendarInterval</key>
    <array>
${entries.join("\n")}
    </array>`;
}

function generateScheduleXml(schedule: LaunchdSchedule): string {
  if (schedule.type === "runAtLoad") {
    return `    <key>RunAtLoad</key>
    <true/>`;
  }

  if (schedule.type === "interval" && schedule.startInterval) {
    return `    <key>StartInterval</key>
    <integer>${schedule.startInterval}</integer>`;
  }

  if (schedule.type === "calendar" && schedule.calendarIntervals) {
    return generateCalendarIntervalXml(schedule.calendarIntervals);
  }

  return "";
}

function generatePlist(
  label: string,
  runnerPath: string,
  command: string,
  schedule: LaunchdSchedule,
  stdoutPath: string,
  stderrPath: string
): string {
  const scheduleXml = generateScheduleXml(schedule);
  const escapedCommand = escapeXml(command);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>

    <key>AssociatedBundleIdentifiers</key>
    <string>com.cronmaster.app</string>

    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(runnerPath)}</string>
        <string>${escapedCommand}</string>
    </array>

${scheduleXml}

    <key>StandardOutPath</key>
    <string>${escapeXml(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

async function ensureLaunchAgentsDir(): Promise<void> {
  if (!existsSync(LAUNCH_AGENTS_DIR)) {
    await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
  }
}

async function ensureLogDir(jobId: string): Promise<void> {
  const logDir = path.join(process.cwd(), "data", "logs", jobId);
  if (!existsSync(logDir)) {
    await mkdir(logDir, { recursive: true });
  }
}

async function launchctlLoad(id: string): Promise<void> {
  const pPath = plistPath(id);
  try {
    await execAsync(`launchctl load "${pPath}"`);
  } catch (error) {
    console.error(`Failed to load plist ${pPath}:`, error);
    throw error;
  }
}

async function launchctlUnload(id: string): Promise<void> {
  const pPath = plistPath(id);
  try {
    await execAsync(`launchctl unload "${pPath}"`);
  } catch {
    // May fail if not loaded — safe to ignore
  }
}

function buildCommand(
  jobId: string,
  rawCommand: string,
  logsEnabled: boolean
): string {
  if (logsEnabled) {
    ensureWrapperScriptInData();
    const wrapperPath = path.join(
      process.cwd(),
      DATA_DIR,
      "cron-log-wrapper.sh"
    );
    return `${wrapperPath} "${jobId}" ${rawCommand}`;
  }
  return rawCommand;
}

export class LaunchdBackend implements SchedulerBackend {
  async listJobs(): Promise<CronJob[]> {
    const allMetadata = await listAllJobMetadata();
    const currentUser = process.env.USER || os.userInfo().username;

    let loadedLabels: Set<string>;
    try {
      const { stdout } = await execAsync(
        `launchctl list | grep "${PLIST_PREFIX}" || true`
      );
      loadedLabels = new Set(
        stdout
          .split("\n")
          .map((line) => line.trim().split(/\s+/).pop() || "")
          .filter((label) => label.startsWith(PLIST_PREFIX))
      );
    } catch {
      loadedLabels = new Set();
    }

    const jobs: CronJob[] = [];

    for (const meta of allMetadata) {
      const pPath = plistPath(meta.id);
      if (!existsSync(pPath)) continue;

      const loaded = loadedLabels.has(plistLabel(meta.id));

      let command = "";
      try {
        const plistContent = await readFile(pPath, "utf-8");
        const cmdMatch =
          plistContent.match(
            /<key>ProgramArguments<\/key>\s*<array>\s*<string>[^<]*<\/string>\s*<string>([^<]*)<\/string>\s*<\/array>/
          ) ||
          plistContent.match(
            /<key>ProgramArguments<\/key>\s*<array>\s*<string>[^<]*<\/string>\s*<string>[^<]*<\/string>\s*<string>([^<]*)<\/string>/
          );
        if (cmdMatch) {
          command = cmdMatch[1]
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'");
        }
      } catch {
        // Plist read failed
      }

      if (meta.logsEnabled && isCommandWrapped(command)) {
        command = unwrapCommand(command);
      }

      jobs.push({
        id: meta.id,
        schedule: meta.schedule,
        command,
        comment: meta.comment,
        user: currentUser,
        paused: !loaded,
        logsEnabled: meta.logsEnabled,
      });
    }

    return jobs;
  }

  async addJob(input: {
    id: string;
    schedule: string;
    command: string;
    comment?: string;
    user: string;
    logsEnabled: boolean;
  }): Promise<boolean> {
    try {
      await ensureLaunchAgentsDir();
      await ensureLogDir(input.id);

      const schedule = cronToLaunchd(input.schedule);
      const finalCommand = buildCommand(
        input.id,
        input.command,
        input.logsEnabled
      );

      const runnerPath = ensureRunnerScriptInData();
      const label = plistLabel(input.id);
      const logDir = path.join(
        process.cwd(),
        "data",
        "logs",
        input.id
      );
      const stdoutPath = path.join(logDir, "launchd-stdout.log");
      const stderrPath = path.join(logDir, "launchd-stderr.log");

      const plistContent = generatePlist(
        label,
        runnerPath,
        finalCommand,
        schedule,
        stdoutPath,
        stderrPath
      );

      const pPath = plistPath(input.id);
      await writeFile(pPath, plistContent, "utf-8");

      const now = new Date().toISOString();
      const meta: JobMetadata = {
        id: input.id,
        comment: input.comment,
        logsEnabled: input.logsEnabled,
        schedule: input.schedule,
        paused: false,
        createdAt: now,
        updatedAt: now,
      };
      await writeJobMetadata(input.id, meta);

      await launchctlLoad(input.id);
      return true;
    } catch (error) {
      console.error("Failed to add launchd job:", error);
      return false;
    }
  }

  async updateJob(
    id: string,
    input: {
      schedule: string;
      command: string;
      comment?: string;
      logsEnabled: boolean;
    }
  ): Promise<boolean> {
    try {
      const existingMeta = await readJobMetadata(id);
      if (!existingMeta) {
        console.error(`Job metadata not found for ${id}`);
        return false;
      }

      await launchctlUnload(id);
      await ensureLogDir(id);

      const schedule = cronToLaunchd(input.schedule);
      const finalCommand = buildCommand(id, input.command, input.logsEnabled);

      const runnerPath = ensureRunnerScriptInData();
      const label = plistLabel(id);
      const logDir = path.join(process.cwd(), "data", "logs", id);
      const stdoutPath = path.join(logDir, "launchd-stdout.log");
      const stderrPath = path.join(logDir, "launchd-stderr.log");

      const plistContent = generatePlist(
        label,
        runnerPath,
        finalCommand,
        schedule,
        stdoutPath,
        stderrPath
      );

      await writeFile(plistPath(id), plistContent, "utf-8");

      const meta: JobMetadata = {
        ...existingMeta,
        schedule: input.schedule,
        comment: input.comment,
        logsEnabled: input.logsEnabled,
        updatedAt: new Date().toISOString(),
      };
      await writeJobMetadata(id, meta);

      if (!existingMeta.paused) {
        await launchctlLoad(id);
      }

      return true;
    } catch (error) {
      console.error("Failed to update launchd job:", error);
      return false;
    }
  }

  async deleteJob(id: string): Promise<boolean> {
    try {
      await launchctlUnload(id);

      const pPath = plistPath(id);
      if (existsSync(pPath)) {
        await unlink(pPath);
      }

      await deleteJobMetadata(id);
      return true;
    } catch (error) {
      console.error("Failed to delete launchd job:", error);
      return false;
    }
  }

  async pauseJob(id: string): Promise<boolean> {
    try {
      await launchctlUnload(id);

      const meta = await readJobMetadata(id);
      if (meta) {
        meta.paused = true;
        meta.updatedAt = new Date().toISOString();
        await writeJobMetadata(id, meta);
      }

      return true;
    } catch (error) {
      console.error("Failed to pause launchd job:", error);
      return false;
    }
  }

  async resumeJob(id: string): Promise<boolean> {
    try {
      await launchctlLoad(id);

      const meta = await readJobMetadata(id);
      if (meta) {
        meta.paused = false;
        meta.updatedAt = new Date().toISOString();
        await writeJobMetadata(id, meta);
      }

      return true;
    } catch (error) {
      console.error("Failed to resume launchd job:", error);
      return false;
    }
  }

  async getUsers(): Promise<string[]> {
    return [process.env.USER || os.userInfo().username];
  }
}
