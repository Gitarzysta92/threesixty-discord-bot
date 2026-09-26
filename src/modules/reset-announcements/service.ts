import { createHash } from 'node:crypto';
import type { Reset, ResetSource } from './api.js';
import type { DeliveryStore } from './store.js';

export interface Announcement { key: string; content: string; nonce: string }
export interface AnnouncementPublisher { publish(announcement: Announcement): Promise<void> }
const completedKey = (reset: Reset) => `completed:${reset.id}:${reset.reset_type}`;
const credit = 'Data from <https://codex-resets.com/?via=dailydev>';
function sourceLink(reset: Reset) {
  if (!reset.source.url) return '';
  const url = new URL(reset.source.url);
  return url.protocol === 'https:' ? `Source: <${url.href}>` : '';
}
function announcement(key: string, content: string): Announcement {
  return { key, content, nonce: createHash('sha256').update(key).digest('hex').slice(0, 24) };
}

export function createResetPoller(source: ResetSource, store: DeliveryStore, publisher: AnnouncementPublisher, signal?: AbortSignal) {
  return async () => {
    signal?.throwIfAborted();
    const snapshot = await source.load();
    signal?.throwIfAborted();
    const sorted = [...snapshot.resets].sort((a, b) => Date.parse(a.announced_at) - Date.parse(b.announced_at) || a.id.localeCompare(b.id));
    // Bootstrap silently records history and publishes only the most recent reset.
    if (!store.initialized()) store.initialize(sorted.slice(0, -1).map(completedKey));
    const pending: Announcement[] = sorted.map(reset => announcement(completedKey(reset), [
      `**Codex reset reported — ${reset.reset_type === 'banked' ? 'banked reset credit' : 'regular usage reset'}**`,
      `Announced <t:${Math.floor(Date.parse(reset.announced_at) / 1000)}:f>.`,
      reset.reset_type === 'banked' ? 'The tracker reports a saved credit, not an immediate refill.' : 'The tracker lists this reset as executed.',
      sourceLink(reset), credit,
    ].filter(Boolean).join('\n')));
    const scheduled = snapshot.scheduled;
    if (scheduled && !snapshot.resets.some(reset => reset.id === scheduled.id)) {
      const key = `scheduled:${scheduled.id}:${scheduled.reset_type}:${scheduled.scheduled_for ?? 'unknown'}`;
      pending.push(announcement(key, [
        `**Codex reset scheduled — ${scheduled.reset_type}**`,
        scheduled.scheduled_for ? `Scheduled for <t:${Math.floor(Date.parse(scheduled.scheduled_for) / 1000)}:f>.` : 'Time has not been announced.',
        'Awaiting execution confirmation from the tracker.', sourceLink(scheduled), credit,
      ].filter(Boolean).join('\n')));
    }
    for (const item of pending) {
      signal?.throwIfAborted();
      if (store.has(item.key)) continue;
      await publisher.publish(item);
      store.mark(item.key);
    }
  };
}
