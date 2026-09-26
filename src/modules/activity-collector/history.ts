import type { ActivityWriter, MessageActivity } from '../../contracts/activity.js';
import type { ActivityRefresher, HistoryCoverage } from '../../contracts/activity-refresh.js';

export interface HistoryMessage { id: string; timestamp: number; activity: MessageActivity | null }
export interface HistorySource {
  channels(signal: AbortSignal): Promise<{ ids: string[]; incomplete: boolean; skipped: number }>;
  messages(channelId: string, before: string, signal: AbortSignal): Promise<HistoryMessage[]>;
}
export const snowflakeBefore = (timestamp: number) => ((BigInt(timestamp) - 1420070400000n) << 22n).toString();
export function missingRanges(from: number, until: number, covered: { from: number; until: number }[]) {
  const gaps: { from: number; until: number }[] = [];
  let cursor = from;
  for (const range of [...covered].sort((a, b) => a.from - b.from)) {
    if (range.until <= cursor) continue;
    if (range.from >= until) break;
    if (range.from > cursor) gaps.push({ from: cursor, until: range.from });
    cursor = Math.max(cursor, range.until);
  }
  if (cursor < until) gaps.push({ from: cursor, until });
  return gaps;
}

export function createHistoryRefresher(source: HistorySource, writer: ActivityWriter, coverage: HistoryCoverage, guildId: string, budgetMs = 8 * 60_000): ActivityRefresher {
  let active: Promise<Awaited<ReturnType<ActivityRefresher['refresh']>>> | undefined;
  const shutdown = new AbortController();
  return {
    refresh(from, until) {
      if (active) return Promise.reject(new Error('An activity refresh is already running. Try again when it finishes.'));
      active = (async () => {
        const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(budgetMs)]);
        const result = { checked: 0, incomplete: 0, discoveryIncomplete: false };
        let channels: Awaited<ReturnType<HistorySource['channels']>>;
        try { channels = await source.channels(signal); }
        catch { return { ...result, discoveryIncomplete: true }; }
        result.discoveryIncomplete = channels.incomplete;
        result.incomplete = channels.skipped;
        for (const channelId of channels.ids) {
          if (signal.aborted) { result.incomplete++; continue; }
          try {
            // Gateway observations are not proof that the surrounding history was scanned.
            for (const gap of missingRanges(from, until, coverage.ranges(guildId, channelId))) {
              let upper = gap.until;
              let before = snowflakeBefore(upper);
              while (upper > gap.from) {
                signal.throwIfAborted();
                const page = await source.messages(channelId, before, signal);
                signal.throwIfAborted();
                if (!page.length) { coverage.mark(guildId, channelId, gap.from, upper); break; }
                const oldest = page.reduce((a, b) => BigInt(a.id) < BigInt(b.id) ? a : b);
                if (BigInt(oldest.id) >= BigInt(before)) throw new Error('History pagination did not advance');
                for (const message of page) {
                  if (message.timestamp >= gap.from && message.timestamp < gap.until && message.activity) writer.record(message.activity);
                }
                const lower = oldest.timestamp < gap.from ? gap.from : oldest.timestamp + 1;
                if (lower < upper) coverage.mark(guildId, channelId, lower, upper);
                if (oldest.timestamp < gap.from || page.length < 100) {
                  coverage.mark(guildId, channelId, gap.from, upper); break;
                }
                upper = Math.min(upper, lower);
                before = oldest.id;
              }
            }
            result.checked++;
          } catch { result.incomplete++; }
        }
        return result;
      })().finally(() => { active = undefined; });
      return active;
    },
    async stop() { shutdown.abort(); await active; },
  };
}
