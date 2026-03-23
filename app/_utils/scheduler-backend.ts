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
  updateJob(
    id: string,
    input: {
      schedule: string;
      command: string;
      comment?: string;
      logsEnabled: boolean;
    }
  ): Promise<boolean>;
  deleteJob(id: string): Promise<boolean>;
  pauseJob(id: string): Promise<boolean>;
  resumeJob(id: string): Promise<boolean>;
  getUsers(): Promise<string[]>;
}
