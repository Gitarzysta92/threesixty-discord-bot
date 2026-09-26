import { createHash } from 'node:crypto';
import type { ActivityReader } from '../../contracts/activity.js';
import { summarize } from './service.js';
import { formatSummary } from './format.js';

const day = 86_400_000;
const warsaw = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function localParts(timestamp: number) {
  const parts = Object.fromEntries(warsaw.formatToParts(timestamp).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), date: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}
// Noon is never ambiguous during Warsaw's daylight-saving transitions.
function warsawNoon(calendarDate: number) {
  const desired = calendarDate + 12 * 3_600_000;
  const parts = localParts(desired);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.date, parts.hour, parts.minute, parts.second);
  return desired - (localAsUtc - desired);
}

/** Most recent Sunday noon and its preceding Sunday noon, both in Warsaw. */
export function latestWeeklyWindow(now: number) {
  const parts = localParts(now);
  const date = Date.UTC(parts.year, parts.month - 1, parts.date);
  let sunday = date - new Date(date).getUTCDay() * day;
  if (warsawNoon(sunday) > now) sunday -= 7 * day;
  return { from: warsawNoon(sunday - 7 * day), until: warsawNoon(sunday) };
}

export interface SummaryDeliveryStore {
  enabledAt(): number;
  has(periodEnd: number): boolean;
  mark(periodEnd: number): void;
}
export interface SummaryPublisher {
  publish(content: string, nonce: string): Promise<void>;
}
export interface WeeklySummaryDependencies {
  store: SummaryDeliveryStore;
  publisher: SummaryPublisher;
  destination: string;
}

export function createWeeklyTick(reader: ActivityReader, guildId: string, retentionDays: number, dependencies: WeeklySummaryDependencies, now = Date.now) {
  return async () => {
    const current = now();
    const window = latestWeeklyWindow(current);
    if (window.until < dependencies.store.enabledAt() || dependencies.store.has(window.until)) return;
    const from = Math.max(window.from, reader.collectionStartedAt(), current - retentionDays * day);
    const content = from >= window.until
      ? '**Weekly activity summary**\nNo retained collection data covers this reporting period.'
      : formatSummary(summarize(reader, guildId, from, window.until), 'Weekly activity summary');
    const period = `Reporting window: <t:${window.from / 1000}:f> to <t:${window.until / 1000}:f> (Sunday noon, Europe/Warsaw).`;
    const nonce = createHash('sha256').update(`${dependencies.destination}:${window.until}`).digest('hex').slice(0, 24);
    await dependencies.publisher.publish(`${content}\n\n${period}`, nonce);
    dependencies.store.mark(window.until);
  };
}
