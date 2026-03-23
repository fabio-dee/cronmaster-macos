# Cronmaster macOS Porting Plan

> Platform port: Linux/Docker → native macOS with **launchd**
> Methodology: Ralph Loop (spec → plan → build → review) + Autoresearch (idiom → perf)
> Date: 2026-03-21

---

## Executive Summary

Cronmaster is a Next.js 16 cron job management platform designed for Linux/Docker.
This port replaces the crontab-based scheduler with **macOS launchd** — Apple's native,
recommended job scheduling system. The UI stays untouched (users still enter cron
expressions), but the entire backend scheduler layer is replaced with plist-based
launchd management.

**Why launchd over cron:**
- Apple's official and recommended scheduler since macOS 10.4
- Survives sleep/wake cycles (cron jobs are skipped during sleep)
- Native process supervision (restart on crash, resource limits)
- Energy-efficient scheduling (coalesced timers)
- No need to enable a deprecated cron daemon

**Architecture approach:** Create a **SchedulerBackend interface** with a launchd
implementation. The existing crontab code stays untouched for upstream compatibility.
The `CronJob` interface is preserved — the UI never knows launchd exists. Users still
enter cron expressions; the backend converts them to launchd calendar intervals.

**Estimated scope:** ~1,200 lines across 5 new files + 6 modified files.
**Risk level:** Medium. Cron-to-launchd schedule conversion has edge cases.
**Key constraint:** launchd `StartCalendarInterval` cannot express every cron pattern
(e.g., `*/3` step values require expansion into multiple entries).

---

## Stage 0 — Setup & Workspace

### 0.1 Prerequisites

No special system setup needed. launchd is always running on macOS.

Verify launchd is operational:
```bash
# Should return the list of loaded services (always works on macOS)
launchctl list | head -5

# Check that LaunchAgents directory exists for current user
ls ~/Library/LaunchAgents/
```

**Permissions:** The app creates plist files in `~/Library/LaunchAgents/`.
No root access needed for user-level jobs. System-wide jobs (`/Library/LaunchDaemons/`)
would require root but are out of scope for v1.

### 0.2 Environment

```bash
# Required
NODE_ENV=development
AUTH_PASSWORD=<your-password>

# Optional (same as upstream)
LOCALE=en
LIVE_UPDATES=true

# NOT needed on macOS (launchd replaces crontab user model):
# HOST_CRONTAB_USER — launchd jobs run as the current user by default
# DOCKER — not applicable
```

### 0.3 Data directories

```bash
mkdir -p scripts data/logs data/sessions data/jobs-metadata snippets
```

New directory: `data/jobs-metadata/` stores job metadata (comment, logsEnabled, etc.)
as JSON files — replacing the crontab comment-based metadata from upstream.

### 0.4 Branch strategy

```
main (upstream: fccview/cronmaster)
  └── macos-port (working branch)
       ├── Phase 1 commits: scheduler backend interface + platform detection
       ├── Phase 2 commits: cron-to-launchd converter
       ├── Phase 3 commits: launchd backend implementation
       ├── Phase 4 commits: rewire cronjob-utils + server actions
       ├── Phase 5 commits: peripheral fixes (ping, HOME, wrapper)
       └── Phase 6 commits: integration testing + polish
```

---

## Stage 1 — Spec: Behavioral Contracts

The upstream has no test framework. These are the behavioral contracts that the
launchd backend must satisfy identically.

### 1.1 Job CRUD Contract (MUST be preserved)

| Operation | UI Input | Expected Backend Effect | Citation |
|-----------|----------|------------------------|----------|
| **List** | Page load | Return `CronJob[]` with id, schedule, command, comment, user, paused, logsEnabled | [cronjob-utils.ts:105-137](app/_utils/cronjob-utils.ts) |
| **Create** | schedule + command + comment | Job becomes scheduled and runs at specified times | [cronjob-utils.ts:139-220](app/_utils/cronjob-utils.ts) |
| **Update** | id + new fields | Job schedule/command changes take effect immediately | [cronjob-utils.ts:253-321](app/_utils/cronjob-utils.ts) |
| **Delete** | id | Job stops running and is removed | [cronjob-utils.ts:222-251](app/_utils/cronjob-utils.ts) |
| **Pause** | id | Job stops running but is remembered (can resume) | [cronjob-utils.ts:323-352](app/_utils/cronjob-utils.ts) |
| **Resume** | id | Paused job starts running again | [cronjob-utils.ts:354-383](app/_utils/cronjob-utils.ts) |
| **Clone** | id + new comment | Duplicate job created with new ID | [actions/cronjobs:171-204](app/_server/actions/cronjobs/index.ts) |
| **Backup/Restore** | id or all | Job data saved to/loaded from JSON files | [actions/cronjobs:428-616](app/_server/actions/cronjobs/index.ts) |

### 1.2 CronJob Interface (MUST NOT change)

> Citation: [cronjob-utils.ts:31-47](app/_utils/cronjob-utils.ts)

```typescript
interface CronJob {
  id: string;            // Short UUID (e.g., "a1b2c3d4")
  schedule: string;      // Cron expression (e.g., "*/5 * * * *") — UI still uses this
  command: string;       // Shell command to execute
  comment?: string;      // User-provided description
  user: string;          // Execution user
  paused?: boolean;      // Whether job is disabled
  logsEnabled?: boolean; // Whether wrapper logging is active
  logError?: {           // Populated from log file analysis
    hasError: boolean;
    lastFailedLog?: string;
    lastFailedTimestamp?: Date;
    exitCode?: number;
    latestExitCode?: number;
    hasHistoricalFailures?: boolean;
  };
}
```

This interface is the **contract between backend and UI**. The UI renders from this.
The launchd backend must produce and consume this exact shape.

### 1.3 Job Execution Contract (MUST be preserved)

| Mode | Trigger | Behavior | Citation |
|------|---------|----------|----------|
| Scheduled | launchd fires at interval | Command runs, logs captured if enabled | New (was cron daemon) |
| Manual sync | "Run" button (no logging) | `execAsync(command)`, 5min timeout, return stdout/stderr | [job-execution-utils.ts:18-51](app/_utils/job-execution-utils.ts) |
| Manual async | "Run" button (logging on) | `spawn()` detached, SSE broadcast, log streaming | [job-execution-utils.ts:53-126](app/_utils/job-execution-utils.ts) |

### 1.4 Metadata Storage Contract (changes from upstream)

**Upstream:** Metadata stored in crontab comment lines:
```
# My backup job | logsEnabled: true | id: a1b2c3d4
*/5 * * * * /path/to/backup.sh
```
> Citation: [line-manipulation-utils.ts:260-281](app/_utils/line-manipulation-utils.ts)

**macOS port:** Metadata stored in JSON sidecar files:
```
data/jobs-metadata/a1b2c3d4.json
{
  "id": "a1b2c3d4",
  "comment": "My backup job",
  "logsEnabled": true,
  "schedule": "*/5 * * * *",
  "createdAt": "2026-03-21T10:00:00Z"
}
```

**Why JSON sidecar instead of plist custom keys:**
- Keeps plists clean and standard (no risk of launchctl ignoring unknown keys)
- Easier to read/write from TypeScript (no XML parsing)
- Backup/restore works by copying JSON files
- `schedule` field preserved in metadata so UI can display the original cron expression

---

## Stage 2 — Spec: launchd Architecture

### 2.1 launchd Plist Structure

Each Cronmaster job maps to one plist file:

**Location:** `~/Library/LaunchAgents/com.cronmaster.job.<id>.plist`
**Naming:** `com.cronmaster.job.a1b2c3d4` (label = reverse-DNS + job ID)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cronmaster.job.a1b2c3d4</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>/path/to/data/cron-log-wrapper.sh "a1b2c3d4" /path/to/backup.sh</string>
    </array>

    <!-- For "0 9 * * 1-5" (9am weekdays): -->
    <key>StartCalendarInterval</key>
    <array>
        <dict>
            <key>Hour</key><integer>9</integer>
            <key>Minute</key><integer>0</integer>
            <key>Weekday</key><integer>1</integer>
        </dict>
        <dict>
            <key>Hour</key><integer>9</integer>
            <key>Minute</key><integer>0</integer>
            <key>Weekday</key><integer>2</integer>
        </dict>
        <!-- ... weekdays 3, 4, 5 ... -->
    </array>

    <!-- launchd native logging (fallback, always on): -->
    <key>StandardOutPath</key>
    <string>/path/to/data/logs/a1b2c3d4/launchd-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/data/logs/a1b2c3d4/launchd-stderr.log</string>
</dict>
</plist>
```

### 2.2 Cron Expression → launchd Conversion Rules

| Cron Pattern | launchd Equivalent | Method |
|---|---|---|
| `* * * * *` | `StartInterval: 60` | Simple interval |
| `*/N * * * *` (N divides 60) | `StartInterval: N*60` | Simple interval |
| `*/N * * * *` (N doesn't divide 60) | Multiple `StartCalendarInterval` entries | Expand minutes list |
| `M H * * *` | `StartCalendarInterval: [{Minute: M, Hour: H}]` | Direct map |
| `M H * * D` | `StartCalendarInterval: [{Minute: M, Hour: H, Weekday: D}]` | Direct map |
| `M H D Mo *` | `StartCalendarInterval: [{Minute: M, Hour: H, Day: D, Month: Mo}]` | Direct map |
| `M H * * D1-D2` | Expand to one entry per weekday in range | Expansion |
| `M1,M2 H * * *` | One entry per minute value | Expansion |
| `M H1-H2 * * *` | One entry per hour in range | Expansion |
| `@reboot` | `RunAtLoad: true` | Special case |
| `@hourly` | `StartCalendarInterval: [{Minute: 0}]` | Alias |
| `@daily` | `StartCalendarInterval: [{Hour: 0, Minute: 0}]` | Alias |
| `@weekly` | `StartCalendarInterval: [{Weekday: 0, Hour: 0, Minute: 0}]` | Alias |
| `@monthly` | `StartCalendarInterval: [{Day: 1, Hour: 0, Minute: 0}]` | Alias |

**Key insight:** `StartCalendarInterval` supports arrays of dictionaries. Each
dictionary fires independently. Complex cron expressions expand into multiple entries.

**Available keys in each `StartCalendarInterval` dict:**
- `Month` (1-12)
- `Day` (1-31)
- `Weekday` (0=Sunday, 1=Monday, ... 6=Saturday) — **NB: cron uses 0=Sunday too**
- `Hour` (0-23)
- `Minute` (0-59)

Omitting a key means "any" (like `*` in cron).

**Expansion example:** `30 9,17 * * 1-5` (9:30 and 17:30 on weekdays) →
```
10 StartCalendarInterval entries:
  {Minute:30, Hour:9, Weekday:1}
  {Minute:30, Hour:9, Weekday:2}
  {Minute:30, Hour:9, Weekday:3}
  {Minute:30, Hour:9, Weekday:4}
  {Minute:30, Hour:9, Weekday:5}
  {Minute:30, Hour:17, Weekday:1}
  {Minute:30, Hour:17, Weekday:2}
  {Minute:30, Hour:17, Weekday:3}
  {Minute:30, Hour:17, Weekday:4}
  {Minute:30, Hour:17, Weekday:5}
```

**Edge case — `*/3` step values (e.g., `*/3 * * * *` = every 3 minutes):**
Cannot use `StartInterval` (would drift). Must expand: minutes 0,3,6,9,...,57 →
20 `StartCalendarInterval` entries, each with only `Minute` key set.

**Safeguard:** If expansion produces >500 entries (pathological expressions like
`*/1 * * * 1-5` = 300 entries), warn the user but still create the plist.
launchd handles large arrays fine.

### 2.3 launchctl Command Map

| Operation | Command | Notes |
|-----------|---------|-------|
| Load (enable) | `launchctl load ~/Library/LaunchAgents/com.cronmaster.job.<id>.plist` | Starts scheduling |
| Unload (disable) | `launchctl unload ~/Library/LaunchAgents/com.cronmaster.job.<id>.plist` | Stops scheduling |
| Run manually | `launchctl start com.cronmaster.job.<id>` | Runs once immediately |
| Check status | `launchctl list com.cronmaster.job.<id>` | Returns PID + exit status |
| List all | `launchctl list \| grep com.cronmaster.job` | All Cronmaster jobs |

**Pause = unload** (plist stays on disk, just not loaded into launchd).
**Resume = load** (re-register the plist with launchd).
**Delete = unload + remove plist file + remove metadata JSON.**

### 2.4 Logging Architecture

**Upstream approach:** Cron commands are wrapped with `cron-log-wrapper.sh` which
captures stdout/stderr/exit code into timestamped log files in `data/logs/<jobId>/`.
The log watcher picks up new files and broadcasts via SSE.

**macOS approach — keep the wrapper, add launchd native logging as fallback:**

1. When `logsEnabled=true`: Command is wrapped with `cron-log-wrapper.sh` (same as
   upstream). The wrapper creates timestamped log files. Log watcher + SSE work unchanged.

2. Additionally, plist always sets `StandardOutPath`/`StandardErrorPath` as a safety net.
   These catch output even if the wrapper fails.

3. The existing log watcher (`log-watcher.ts`) monitors `data/logs/` — works unchanged.

**Why keep the wrapper instead of using only launchd native logging:**
- The wrapper captures exit codes in a structured format the UI parses
  (`"Exit Code : ${EXIT_CODE}"` — see [cron-log-wrapper.sh:60](app/_scripts/cron-log-wrapper.sh))
- The wrapper creates timestamped log files (one per run) vs. launchd's single appending file
- The entire SSE + log streaming UI depends on this format
- Zero UI changes required

---

## Stage 3a — Gap Analysis

### 3a.1 Architectural Gap

```
Upstream architecture:
  cronjob-utils.ts → crontab-utils.ts → crontab lines (text parsing)
  Server actions → cronjob-utils → line-manipulation-utils (text CRUD)
  isDocker() branching everywhere

macOS architecture:
  cronjob-utils.ts → scheduler-backend.ts → launchd-backend.ts → plist files + JSON metadata
  Server actions → cronjob-utils (unchanged API) → scheduler backend
  isMacOS() selects launchd backend
```

**Key design principle:** `cronjob-utils.ts` exports the same functions with the same
signatures. Internally it delegates to the appropriate backend. Server actions and UI
don't change.

### 3a.2 File Impact Map

```
NEW FILES (launchd implementation):
├── app/_utils/platform-utils.ts ............. Platform detection (~15 lines)
├── app/_utils/scheduler-backend.ts .......... Backend interface (~40 lines)
├── app/_utils/launchd-backend.ts ............ launchd implementation (~400 lines)
├── app/_utils/cron-to-launchd.ts ............ Cron→calendar interval converter (~200 lines)
└── app/_utils/jobs-metadata-utils.ts ........ JSON metadata store (~100 lines)

MODIFIED FILES (rewired to use scheduler backend):
├── app/_utils/cronjob-utils.ts .............. Delegate to scheduler backend (~150 lines changed)
├── app/_utils/job-execution-utils.ts ........ Remove Docker/nsenter, add launchctl start (~30 lines)
├── app/_utils/wrapper-utils.ts .............. Add plist StandardOutPath support (~20 lines)
├── app/_utils/system-stats-utils.ts ......... Fix ping command (~5 lines)
├── app/_server/actions/global/index.ts ...... Export isMacOS() (~10 lines)
└── app/_server/actions/cronjobs/index.ts .... Minor: remove crontab-specific imports (~20 lines)

UNTOUCHED (upstream-compatible):
├── app/_consts/commands.ts .................. Kept for Linux/Docker (not used on macOS path)
├── app/_consts/nsenter.ts ................... Kept for Linux/Docker (not used on macOS path)
├── app/_utils/crontab-utils.ts .............. Kept for Linux/Docker backend
├── app/_utils/files-manipulation-utils.ts ... Kept for Linux/Docker backend
├── app/_utils/line-manipulation-utils.ts .... Kept for Linux/Docker backend
├── app/_utils/process-utils.ts .............. POSIX-standard, works on macOS
├── app/_utils/log-watcher.ts ................ Node.js fs.watch, works on macOS
├── app/_utils/running-jobs-utils.ts ......... JSON file I/O, works on macOS
├── app/_utils/scripts-utils.ts .............. File scanning, works on macOS
├── app/_utils/snippets-utils.ts ............. File scanning, works on macOS
├── app/_utils/backup-utils.ts ............... File I/O, works on macOS
├── app/_scripts/cron-log-wrapper.sh ......... bash 3.2 compatible, works on macOS
├── app/_components/**/* ..................... All 50+ UI components — zero changes
├── app/_contexts/* .......................... SSE context — zero changes
├── app/_hooks/* ............................. Custom hooks — zero changes
├── app/_providers/* ......................... Theme provider — zero changes
├── app/_translations/* ...................... i18n files — zero changes
├── app/api/**/* ............................. API routes — zero changes
├── proxy.ts ................................. Auth middleware — zero changes
└── next.config.mjs .......................... Build config — zero changes
```

### 3a.3 What Does NOT Need Changing

- **All UI components** — still render `CronJob` objects, still show cron expressions
- **SSE system** — still broadcasts job-started/completed/failed events
- **Authentication** — cookie/session-based, no platform deps
- **Log watcher** — still watches `data/logs/` directory
- **Log wrapper script** — bash 3.2 compatible, used unchanged
- **Script/snippet management** — `chmod +x`, `bash <script>`, file I/O
- **Process management** — `kill -0`, `ps` — POSIX standard
- **Backup/restore** — operates on `CronJob` objects, not crontab text

---

## Stage 3b — Build Plan (Task Breakdown)

### Phase 1: Foundation (2 tasks)

**Task 1.1 — Create platform detection utility**

Create `app/_utils/platform-utils.ts`:
```typescript
export const isMacOS = (): boolean => process.platform === "darwin";
export const isLinux = (): boolean => process.platform === "linux";
```

---

**Task 1.2 — Create scheduler backend interface**

Create `app/_utils/scheduler-backend.ts`:
```typescript
import { CronJob } from "./cronjob-utils";

export interface SchedulerBackend {
  listJobs(): Promise<CronJob[]>;
  addJob(input: {
    id: string;
    schedule: string;
    command: string;
    comment?: string;
    user: string;
    logsEnabled: boolean;
  }): Promise<boolean>;
  updateJob(id: string, input: {
    schedule: string;
    command: string;
    comment?: string;
    logsEnabled: boolean;
  }): Promise<boolean>;
  deleteJob(id: string): Promise<boolean>;
  pauseJob(id: string): Promise<boolean>;
  resumeJob(id: string): Promise<boolean>;
  getUsers(): Promise<string[]>;
}
```

This interface is the seam between the UI/actions layer and the platform-specific
scheduler. Both crontab (Linux) and launchd (macOS) implement it.

---

### Phase 2: Cron-to-launchd Converter (1 task)

**Task 2.1 — Create `app/_utils/cron-to-launchd.ts`**

This is the most algorithmically complex part. Must handle:

**Input:** Standard cron expression string (5 fields: minute hour day month weekday)
**Output:** launchd schedule config — either `StartInterval` or `StartCalendarInterval`

```typescript
interface LaunchdSchedule {
  type: "interval" | "calendar";
  startInterval?: number;  // seconds between runs
  calendarIntervals?: Array<{
    Month?: number;
    Day?: number;
    Weekday?: number;
    Hour?: number;
    Minute?: number;
  }>;
}

export function cronToLaunchd(cronExpression: string): LaunchdSchedule;
```

**Algorithm:**
1. Handle aliases: `@reboot` → `RunAtLoad`, `@hourly/@daily/@weekly/@monthly` → single calendar entry
2. Parse 5 fields into sets of allowed values (expand `*/N`, `N-M`, `N,M`)
3. **Optimization:** If only minute field has a single `*/N` pattern and all other fields are `*`:
   - Use `StartInterval: N * 60` (simpler, more efficient)
4. **Otherwise:** Compute cartesian product of all non-wildcard fields
   - Each combination becomes one `StartCalendarInterval` entry
   - Wildcard fields are omitted (launchd treats missing keys as "any")

**Test cases for the converter:**

| Input | Expected Output |
|-------|----------------|
| `* * * * *` | `{type: "interval", startInterval: 60}` |
| `*/5 * * * *` | `{type: "interval", startInterval: 300}` |
| `*/3 * * * *` | `{type: "calendar", calendarIntervals: [{Minute:0},{Minute:3},...,{Minute:57}]}` (20 entries) |
| `0 9 * * *` | `{type: "calendar", calendarIntervals: [{Minute:0, Hour:9}]}` |
| `0 9 * * 1-5` | `{type: "calendar", calendarIntervals: [{Minute:0, Hour:9, Weekday:1},...]}` (5 entries) |
| `30 9,17 * * 1-5` | 10 entries (2 hours x 5 weekdays) |
| `0 0 1 * *` | `{type: "calendar", calendarIntervals: [{Minute:0, Hour:0, Day:1}]}` |
| `@hourly` | `{type: "calendar", calendarIntervals: [{Minute:0}]}` |
| `@reboot` | Special case: `RunAtLoad: true` |

**Leverage existing dep:** The project already has `cron-parser` (v5.3.0) which can
parse cron expressions into field objects. Use it instead of writing a parser from scratch.

> Citation: [package.json dependency](package.json) — `"cron-parser": "^5.3.0"`

---

### Phase 3: launchd Backend Implementation (2 tasks)

**Task 3.1 — Create `app/_utils/jobs-metadata-utils.ts`**

JSON-based metadata store replacing crontab comment metadata.

```typescript
interface JobMetadata {
  id: string;
  comment?: string;
  logsEnabled: boolean;
  schedule: string;       // Original cron expression (for UI display)
  paused: boolean;
  createdAt: string;      // ISO timestamp
  updatedAt: string;
}

// File operations:
export function readJobMetadata(id: string): Promise<JobMetadata | null>;
export function writeJobMetadata(id: string, meta: JobMetadata): Promise<void>;
export function deleteJobMetadata(id: string): Promise<void>;
export function listAllJobMetadata(): Promise<JobMetadata[]>;
```

Storage: `data/jobs-metadata/<id>.json` — one file per job.
Uses `proper-lockfile` for concurrent access safety (already a project dependency).

---

**Task 3.2 — Create `app/_utils/launchd-backend.ts`**

Implements `SchedulerBackend` interface using launchd + metadata store.

**Core operations:**

```typescript
export class LaunchdBackend implements SchedulerBackend {

  async listJobs(): Promise<CronJob[]> {
    // 1. Scan ~/Library/LaunchAgents/com.cronmaster.job.*.plist
    // 2. For each plist, read corresponding metadata JSON
    // 3. Check launchctl list to determine if loaded (paused = not loaded)
    // 4. Build CronJob objects
  }

  async addJob(input): Promise<boolean> {
    // 1. Convert cron expression to launchd schedule (cron-to-launchd.ts)
    // 2. If logsEnabled, wrap command with cron-log-wrapper.sh
    // 3. Generate plist XML
    // 4. Write plist to ~/Library/LaunchAgents/
    // 5. Write metadata JSON to data/jobs-metadata/
    // 6. launchctl load the plist
  }

  async updateJob(id, input): Promise<boolean> {
    // 1. launchctl unload existing plist
    // 2. Regenerate plist with new schedule/command
    // 3. Overwrite plist file
    // 4. Update metadata JSON
    // 5. launchctl load updated plist
  }

  async deleteJob(id): Promise<boolean> {
    // 1. launchctl unload plist
    // 2. Delete plist file
    // 3. Delete metadata JSON
  }

  async pauseJob(id): Promise<boolean> {
    // 1. launchctl unload plist (stops scheduling)
    // 2. Update metadata: paused = true
    // (plist stays on disk for resume)
  }

  async resumeJob(id): Promise<boolean> {
    // 1. launchctl load plist (re-enables scheduling)
    // 2. Update metadata: paused = false
  }

  async getUsers(): Promise<string[]> {
    // Return [process.env.USER] — launchd user agents run as current user
  }
}
```

**Plist generation:** Use string templates (not an XML library) — plists are
simple enough that template strings with proper escaping are cleaner than
pulling in a dependency.

```typescript
function generatePlist(label: string, args: string[], schedule: LaunchdSchedule,
                       stdoutPath: string, stderrPath: string): string {
  // Returns well-formed XML plist string
}
```

**Command escaping for plist:** The `ProgramArguments` array avoids shell injection
by using separate array elements instead of a single shell string:
```xml
<array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string><!-- command here, XML-escaped --></string>
</array>
```

XML special characters (`&`, `<`, `>`, `"`, `'`) must be escaped in the command string.

---

### Phase 4: Rewire cronjob-utils (2 tasks)

**Task 4.1 — Refactor `app/_utils/cronjob-utils.ts`**
> Citation: [cronjob-utils.ts:1-430](app/_utils/cronjob-utils.ts)

Replace the internals with scheduler backend delegation:

```typescript
import { isMacOS } from "./platform-utils";
import { LaunchdBackend } from "./launchd-backend";
// Existing crontab imports stay for Linux fallback

const getBackend = (): SchedulerBackend => {
  if (isMacOS()) return new LaunchdBackend();
  // Linux/Docker: wrap existing functions into SchedulerBackend shape
  return crontabBackend;
};

export const getCronJobs = async (includeLogErrors = true): Promise<CronJob[]> => {
  const backend = getBackend();
  let jobs = await backend.listJobs();

  if (includeLogErrors) {
    const { getAllJobLogErrors } = await import("@/app/_server/actions/logs");
    const jobIds = jobs.map(j => j.id);
    const errorMap = await getAllJobLogErrors(jobIds);
    jobs = jobs.map(job => ({ ...job, logError: errorMap.get(job.id) }));
  }

  return jobs;
};

export const addCronJob = async (...) => {
  const backend = getBackend();
  return backend.addJob({ id: generateShortUUID(), schedule, command, ... });
};

// ... same pattern for delete, update, pause, resume
```

**Important:** The function signatures (`addCronJob`, `deleteCronJob`, etc.) stay
identical. Server actions call the same functions. No changes upstream.

---

**Task 4.2 — Update `app/_utils/job-execution-utils.ts`**
> Citation: [job-execution-utils.ts:1-237](app/_utils/job-execution-utils.ts)

Changes:
1. Remove nsenter path (not applicable on macOS)
2. For manual execution on macOS: run command directly (same as non-Docker Linux path)
3. Fix HOME fallback: `process.env.HOME || os.homedir()` instead of `"/home"`

The Docker branch stays for Linux compatibility:

```typescript
if (docker) {
  // Existing nsenter code — unchanged
} else {
  // Works on both Linux native and macOS
  command = job.command;
}

const { stdout, stderr } = await execAsync(command, {
  timeout: 300000,
  cwd: process.env.HOME || os.homedir(),  // Fix: was "/home"
});
```

**Optional enhancement:** Add `launchctl start com.cronmaster.job.<id>` as an
alternative manual run path. Advantage: runs with the same environment as
scheduled runs. Disadvantage: no direct stdout capture.
**Recommendation:** Keep direct execution for manual runs (simpler, consistent UX).

---

### Phase 5: Peripheral Fixes (2 tasks)

**Task 5.1 — Fix ping command for macOS**
> Citation: [system-stats-utils.ts:25-35](app/_utils/system-stats-utils.ts)

```typescript
import { isMacOS } from "./platform-utils";

export const getPing = async (): Promise<number> => {
  const cmd = isMacOS()
    ? 'ping -c 1 -t 2 8.8.8.8 2>/dev/null || echo "timeout"'
    : 'ping -c 1 -W 1000 8.8.8.8 2>/dev/null || echo "timeout"';
  // ... rest unchanged
};
```

---

**Task 5.2 — Update `app/_server/actions/global/index.ts`**
> Citation: [global/index.ts:1-87](app/_server/actions/global/index.ts)

Add macOS platform export. The existing `isDocker()` already returns `false` on macOS
(no `/.dockerenv`, no `/proc/1/cgroup`), which is correct.

```typescript
export const isMacOS = (): boolean => process.platform === "darwin";
```

The `getHostDataPath()` and `getHostScriptsPath()` functions already return `null`
when `isDocker()` is false — correct behavior on macOS.

---

### Phase 6: Integration Testing & Polish (2 tasks)

**Task 6.1 — End-to-end manual verification**

**Review checklist:**
- [ ] `yarn dev` starts without errors on macOS
- [ ] System stats sidebar shows CPU, memory, GPU, network, disk
- [ ] Job list loads (empty state if no jobs, populated if plist files exist)
- [ ] Create a job with `*/5 * * * *` schedule → plist appears in `~/Library/LaunchAgents/`
- [ ] Verify plist content: `StartInterval: 300`, correct `ProgramArguments`
- [ ] `launchctl list | grep cronmaster` shows the loaded job
- [ ] Create a job with `0 9 * * 1-5` → verify 5 `StartCalendarInterval` entries in plist
- [ ] Edit a job's schedule → plist updated, old schedule unloaded, new one loaded
- [ ] Pause a job → `launchctl list` no longer shows it, metadata says paused
- [ ] Resume a job → `launchctl list` shows it again
- [ ] Delete a job → plist removed, metadata removed, `launchctl list` clean
- [ ] Clone a job → new plist + metadata created with different ID
- [ ] Enable logging → command wrapped with `cron-log-wrapper.sh` in plist
- [ ] Run a job manually (sync, no logging) → output displayed in UI
- [ ] Run a job manually (async, logging on) → SSE events fire, logs stream
- [ ] Wait for a scheduled job to fire → log file created, SSE broadcast
- [ ] Script management → create, edit, execute, delete scripts
- [ ] Backup a job → JSON file created in `data/backup/`
- [ ] Restore a job → plist + metadata recreated
- [ ] Login/logout works
- [ ] Dark/light theme toggle works

---

**Task 6.2 — Edge case verification**

- [ ] Job with `@reboot` schedule → plist has `RunAtLoad: true`
- [ ] Job with `*/1 * * * *` → `StartInterval: 60` (not 60 calendar entries)
- [ ] Job with `*/7 * * * *` → expanded to minutes 0,7,14,21,28,35,42,49,56
- [ ] Job command containing special XML chars (`&`, `<`, `>`) → properly escaped in plist
- [ ] Job command containing single/double quotes → properly escaped
- [ ] Long-running job (>5 min) → process monitor detects completion via log
- [ ] Job that fails (exit code != 0) → failure SSE event, log error indicator in UI
- [ ] Multiple jobs loaded simultaneously → all appear in `launchctl list`
- [ ] App restart → jobs still scheduled (launchd persists loaded plists)
- [ ] System reboot → jobs survive (LaunchAgents auto-load at login)

---

## Stage 5 — Idiom: macOS-Native Enhancements (Autoresearch)

Post-port experiments. Each is independent — measure → keep or revert.

### 5.1 macOS Notification Center Integration

**Hypothesis:** Native macOS notifications for job completion improve awareness.

**Approach:** After SSE `job-completed`/`job-failed` broadcast, also trigger:
```bash
osascript -e 'display notification "Job completed: backup-db" with title "Cronmaster" sound name "default"'
```

**Metric:** Qualitative — does the user find it useful?

### 5.2 Homebrew Distribution

**Hypothesis:** `brew install cronmaster-macos` increases adoption.

```ruby
class CronmasterMacos < Formula
  desc "Modern job management platform for macOS (launchd)"
  homepage "https://github.com/0xD-Fabio/cronmaster-macos"
  depends_on "node@20"

  service do
    run [opt_prefix/"bin/cronmaster"]
    keep_alive true
    working_dir var/"cronmaster"
  end
end
```

### 5.3 Temperature Sensor Re-enable

> Citation: [next.config.mjs webpack alias](next.config.mjs)

Upstream disables `osx-temperature-sensor`. On macOS, re-enabling it could add
CPU/GPU temperature to the system stats sidebar. Experiment on Apple Silicon.

### 5.4 launchd Status Enrichment

**Hypothesis:** Showing launchd-specific status (last exit code, last run time)
in the UI provides better visibility than just "running"/"paused".

**Approach:** Parse `launchctl list com.cronmaster.job.<id>` output:
```
{
    "LimitLoadToSessionType" = "Aqua";
    "Label" = "com.cronmaster.job.a1b2c3d4";
    "LastExitStatus" = 0;
    "PID" = 12345;         // Present only if currently running
}
```

Expose `LastExitStatus` and current PID (if running) in the CronJob object.

---

## Stage 6 — Perf: macOS-Specific Optimizations (Autoresearch)

### 6.1 systeminformation Cold Start

GPU detection via `system_profiler SPDisplaysDataType` is slow (~2s) on macOS.

**Metric:** Time from page load to system stats displayed.
**Experiment:** Lazy-load GPU data after initial render.

### 6.2 Plist I/O Performance

Reading multiple plists on job list could be slow with many jobs.

**Metric:** Time for `listJobs()` with 50+ jobs.
**Experiment:** Cache job list in memory with file-watcher invalidation.

### 6.3 launchctl Subprocess Overhead

Each `launchctl list` call spawns a subprocess.

**Metric:** Latency per `listJobs()` call.
**Experiment:** Batch status checks into single `launchctl list | grep cronmaster`
call instead of per-job `launchctl list <label>`.

---

## Backpressure Configuration

1. **TypeScript compiler** — `yarn build` must succeed with zero errors
2. **ESLint** — `yarn lint` must pass
3. **Manual smoke test** — Phase 6 review checklist
4. **Runtime validation** — `yarn dev` must start and serve pages

**Recommended addition:**
- Vitest unit tests for `cron-to-launchd.ts` (the converter has clear input/output)
- Integration test: create plist → verify launchctl loads it → unload → cleanup

---

## File Change Summary

| File | Action | Lines (est.) |
|------|--------|-------------|
| `app/_utils/platform-utils.ts` | **NEW** | ~15 |
| `app/_utils/scheduler-backend.ts` | **NEW** | ~40 |
| `app/_utils/cron-to-launchd.ts` | **NEW** | ~200 |
| `app/_utils/jobs-metadata-utils.ts` | **NEW** | ~100 |
| `app/_utils/launchd-backend.ts` | **NEW** | ~400 |
| `app/_utils/cronjob-utils.ts` | MODIFY | ~150 lines changed |
| `app/_utils/job-execution-utils.ts` | MODIFY | ~30 |
| `app/_utils/wrapper-utils.ts` | MODIFY | ~20 |
| `app/_utils/system-stats-utils.ts` | MODIFY | ~5 |
| `app/_server/actions/global/index.ts` | MODIFY | ~10 |
| `app/_server/actions/cronjobs/index.ts` | MODIFY | ~20 |
| **Total** | | **~990 lines** |

---

## Execution Order & Dependencies

```
Phase 1 (foundation — no dependencies)
  ├── Task 1.1: platform-utils.ts
  └── Task 1.2: scheduler-backend.ts (interface only)

Phase 2 (converter — depends on Phase 1)
  └── Task 2.1: cron-to-launchd.ts
      (most complex task — write unit tests here)

Phase 3 (launchd backend — depends on Phase 1 + 2)
  ├── Task 3.1: jobs-metadata-utils.ts
  └── Task 3.2: launchd-backend.ts (depends on 2.1 + 3.1)

Phase 4 (rewire — depends on Phase 3)
  ├── Task 4.1: cronjob-utils.ts refactor
  └── Task 4.2: job-execution-utils.ts update

Phase 5 (peripheral — can run parallel with Phase 4)
  ├── Task 5.1: ping fix
  └── Task 5.2: global/index.ts update

Phase 6 (validation — depends on all above)
  ├── Task 6.1: end-to-end manual verification
  └── Task 6.2: edge case verification
```

---

## Risk Register

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Cron expression too complex for launchd | Medium | Schedule mismatch | Expand all patterns into explicit calendar entries; warn on >500 entries |
| `launchctl load` fails silently | Medium | Job not scheduled | Check `launchctl list <label>` after load; return error if not found |
| Plist XML malformed | Low | launchctl rejects file | Validate plist with `plutil -lint` before loading |
| App runs without Full Disk Access | Low | Plist write fails | `~/Library/LaunchAgents/` doesn't require FDA; only system dirs do |
| `cron-log-wrapper.sh` incompatible with macOS bash 3.2 | Low | Logging broken | Script uses only POSIX features; already verified |
| User expects `crontab -l` to show jobs | Medium | Confusion | Document that jobs are in launchd, not crontab; add `launchctl list` equivalent |
| launchd coalesces timer events during sleep | Low | Missed runs accumulate | Document: launchd runs missed jobs on wake (unlike cron which skips them) |
| System reboot during plist write | Very Low | Corrupt plist | Atomic write pattern: write to temp file, then rename |
| Multiple Cronmaster instances conflict | Low | Double-loaded plists | Use plist label as mutex; check before load |

---

## Decision Log

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Scheduler | **launchd** | BSD cron | Apple's recommended scheduler; survives sleep; native process supervision |
| Architecture | **SchedulerBackend interface** | Patch existing code | Clean separation; preserves upstream compatibility; enables future backends |
| Metadata storage | **JSON sidecar files** | Custom plist keys; SQLite | Simple, no new deps, easy backup/restore, TypeScript-native |
| Cron expression handling | **Convert to launchd intervals** | Drop cron syntax for launchd UI | Preserves UI compatibility; users keep familiar cron expressions |
| Plist generation | **String templates** | plist npm package | Simple enough format; no dependency needed; full control over output |
| Manual job execution | **Direct exec (not launchctl start)** | `launchctl start` | Direct exec captures stdout; consistent with upstream UX |
| Logging | **Keep wrapper script** | launchd native StandardOutPath only | Wrapper produces structured logs the UI parses; zero UI changes |
| User model | **Single user (current)** | Multi-user with LaunchDaemons | LaunchAgents = no root needed; LaunchDaemons = v2 if needed |
| Upstream code | **Keep intact, don't delete** | Remove Linux/Docker code | Enables upstream merges; Linux code paths are dead on macOS |
