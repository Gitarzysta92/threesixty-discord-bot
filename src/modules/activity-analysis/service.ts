import type { ActivityReader } from '../../contracts/activity.js';

export function summarize(reader: ActivityReader, guildId: string, from: number, until: number) {
  if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until) throw new Error('Invalid activity range');
  let messages = 0;
  const users = new Set<string>();
  const channels = new Map<string, number>();
  const days = new Map<string, number>();
  for (const event of reader.read(guildId, from, until)) {
    messages++;
    users.add(event.userId);
    channels.set(event.channelId, (channels.get(event.channelId) ?? 0) + 1);
    const date = new Date(event.occurredAt).toISOString().slice(0, 10);
    days.set(date, (days.get(date) ?? 0) + 1);
  }
  return {
    from, until, collectionStartedAt: reader.collectionStartedAt(), messages, activeMembers: users.size,
    channels: [...channels].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    days: [...days].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
