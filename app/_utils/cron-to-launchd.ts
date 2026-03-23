import { CronExpressionParser } from "cron-parser";

export interface CalendarInterval {
  Month?: number;
  Day?: number;
  Weekday?: number;
  Hour?: number;
  Minute?: number;
}

export interface LaunchdSchedule {
  type: "interval" | "calendar" | "runAtLoad";
  startInterval?: number;
  calendarIntervals?: CalendarInterval[];
}

const ALIASES: Record<string, LaunchdSchedule> = {
  "@hourly": {
    type: "calendar",
    calendarIntervals: [{ Minute: 0 }],
  },
  "@daily": {
    type: "calendar",
    calendarIntervals: [{ Hour: 0, Minute: 0 }],
  },
  "@midnight": {
    type: "calendar",
    calendarIntervals: [{ Hour: 0, Minute: 0 }],
  },
  "@weekly": {
    type: "calendar",
    calendarIntervals: [{ Weekday: 0, Hour: 0, Minute: 0 }],
  },
  "@monthly": {
    type: "calendar",
    calendarIntervals: [{ Day: 1, Hour: 0, Minute: 0 }],
  },
  "@annually": {
    type: "calendar",
    calendarIntervals: [{ Month: 1, Day: 1, Hour: 0, Minute: 0 }],
  },
  "@yearly": {
    type: "calendar",
    calendarIntervals: [{ Month: 1, Day: 1, Hour: 0, Minute: 0 }],
  },
};

function normalizeDayOfWeek(values: number[]): number[] {
  const set = new Set<number>();
  for (const v of values) {
    set.add(v === 7 ? 0 : v);
  }
  return Array.from(set).sort((a, b) => a - b);
}

export function cronToLaunchd(cronExpression: string): LaunchdSchedule {
  const trimmed = cronExpression.trim().toLowerCase();

  if (trimmed === "@reboot") {
    return { type: "runAtLoad" };
  }

  const alias = ALIASES[trimmed];
  if (alias) {
    return alias;
  }

  const parsed = CronExpressionParser.parse(cronExpression);
  const serialized = parsed.fields.serialize();

  const minuteValues = serialized.minute.values as number[];
  const hourValues = serialized.hour.values as number[];
  const domValues = serialized.dayOfMonth.values as number[];
  const monthValues = serialized.month.values as number[];
  const dowValues = serialized.dayOfWeek.values as number[];

  const minuteWild = serialized.minute.wildcard;
  const hourWild = serialized.hour.wildcard;
  const domWild = serialized.dayOfMonth.wildcard;
  const monthWild = serialized.month.wildcard;
  const dowWild = serialized.dayOfWeek.wildcard;

  const restWild = hourWild && domWild && monthWild && dowWild;

  if (restWild) {
    const rawMinute = parsed.fields.stringifyField(parsed.fields.minute);
    const stepMatch = rawMinute.match(/^\*\/(\d+)$/);

    if (minuteWild) {
      return { type: "interval", startInterval: 60 };
    }

    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10);
      return { type: "interval", startInterval: step * 60 };
    }
  }

  const minuteArr = minuteWild ? [undefined] : minuteValues;
  const hourArr = hourWild ? [undefined] : hourValues;
  const domArr = domWild ? [undefined] : domValues;
  const monthArr = monthWild ? [undefined] : monthValues;
  const dowArr = dowWild
    ? [undefined]
    : normalizeDayOfWeek(dowValues);

  const intervals: CalendarInterval[] = [];

  for (const month of monthArr) {
    for (const dom of domArr) {
      for (const dow of dowArr) {
        for (const hour of hourArr) {
          for (const minute of minuteArr) {
            const entry: CalendarInterval = {};
            if (month !== undefined) entry.Month = month;
            if (dom !== undefined) entry.Day = dom;
            if (dow !== undefined) entry.Weekday = dow;
            if (hour !== undefined) entry.Hour = hour;
            if (minute !== undefined) entry.Minute = minute;
            intervals.push(entry);
          }
        }
      }
    }
  }

  return { type: "calendar", calendarIntervals: intervals };
}
