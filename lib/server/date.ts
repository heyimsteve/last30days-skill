import { DateConfidence } from "@/lib/types";

export function getDateRange(days: number) {
  const today = new Date();
  const to = formatDate(today);
  const fromDate = new Date(today);
  fromDate.setUTCDate(fromDate.getUTCDate() - days);
  return { from: formatDate(fromDate), to };
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseDate(dateValue: string | null | undefined): Date | null {
  if (!dateValue) {
    return null;
  }

  const ts = Number(dateValue);
  if (!Number.isNaN(ts) && ts > 1000000000 && ts < 9999999999) {
    const fromTs = new Date(ts * 1000);
    return Number.isNaN(fromTs.valueOf()) ? null : fromTs;
  }

  const parsed = new Date(dateValue);
  if (!Number.isNaN(parsed.valueOf())) {
    return parsed;
  }

  return null;
}

export function toIsoDate(dateValue: string | null | undefined): string | null {
  const parsed = parseDate(dateValue);
  return parsed ? formatDate(parsed) : null;
}

export function getDateConfidence(dateValue: string | null, from: string, to: string): DateConfidence {
  if (!dateValue) {
    return "low";
  }

  if (dateValue < from || dateValue > to) {
    return "low";
  }

  return "high";
}

export function daysAgo(dateValue: string | null): number | null {
  if (!dateValue) {
    return null;
  }

  const parsed = new Date(`${dateValue}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) {
    return null;
  }

  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const diff = todayUtc.getTime() - parsed.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export function recencyScore(dateValue: string | null, maxDays = 30): number {
  const age = daysAgo(dateValue);
  if (age === null) {
    return 0;
  }
  if (age < 0) {
    return 100;
  }
  if (age >= maxDays) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.floor(100 * (1 - age / maxDays))));
}

export function isWithinRange(dateValue: string | null, from: string, to: string): boolean {
  if (!dateValue) {
    return true;
  }
  return dateValue >= from && dateValue <= to;
}
