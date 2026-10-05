import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { escapeMarkdown } from 'discord.js';
import { RetryLater } from './api.js';
import type { AnnouncementPublisher } from './service.js';
import type { DeliveryStore } from './store.js';

export const challengeUrl = 'https://codex-resets.com/tibo-28';
export interface ChallengeDay { day: number; date: string; text: string }
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

// The public API exposes resets only. Read the server-rendered daily log,
// excluding interactive widgets so clocks and vote counts cannot trigger posts.
export function parseChallenge(html: string): ChallengeDay[] {
  const $ = load(html);
  const ledger = $('.challenge-ledger');
  if (ledger.length !== 1) throw new Error('Challenge daily log is missing');
  const days: ChallengeDay[] = [];
  ledger.children('.challenge-row').each((_, element) => {
    const row = $(element);
    const day = Number(row.attr('id')?.match(/^day-(\d+)$/)?.[1]);
    const date = row.find('.challenge-row-date time').attr('datetime') ?? '';
    const body = row.find('.challenge-row-body').clone();
    body.find('script, style, button, form, [class*="vote"], [class*="poll"]').remove();
    // Preserve word boundaries between adjacent blocks in compact HTML.
    body.find('*').append(' ');
    const text = body.text().replace(/\s+/g, ' ').trim();
    if (!Number.isInteger(day) || day < 1 || day > 28 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !text || days.some(item => item.day === day)) {
      throw new Error('Invalid challenge daily log entry');
    }
    days.push({ day, date, text });
  });
  if (!days.length) throw new Error('Challenge daily log is empty');
  return days.sort((a, b) => a.day - b.day);
}

export function createChallengeSource(fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  return { async load() {
    const response = await fetcher(challengeUrl, {
      headers: { Accept: 'text/html' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    if (response.status === 429) {
      const raw = response.headers.get('retry-after');
      const seconds = Number(raw);
      const delay = raw && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw ?? '') - Date.now();
      throw new RetryLater(Number.isFinite(delay) ? Math.max(60_000, delay) : 300_000);
    }
    if (!response.ok) throw new Error(`Challenge page returned HTTP ${response.status}`);
    return parseChallenge(await response.text());
  } };
}

export function createChallengePoller(source: { load(): Promise<ChallengeDay[]> }, store: DeliveryStore, publisher: AnnouncementPublisher, signal?: AbortSignal) {
  return async () => {
    signal?.throwIfAborted();
    const days = await source.load();
    signal?.throwIfAborted();
    const items = days.map(day => {
      const content = `**Tibo’s 28-day challenge · Day ${day.day} of 28**\n${day.date} (PT) · ${escapeMarkdown(day.text).slice(0, 1500)}\nDaily log: <${challengeUrl}#day-${day.day}>`;
      return { key: `challenge:tibo-28:${digest(content)}`, content };
    });
    // Separate bootstrap from reset receipts so existing destinations get the
    // latest challenge day once without replaying the whole challenge.
    const initialized = 'challenge:tibo-28:initialized';
    if (!store.has(initialized)) {
      for (const item of items.slice(0, -1)) store.mark(item.key);
      store.mark(initialized);
    }
    for (const item of items) {
      signal?.throwIfAborted();
      if (store.has(item.key)) continue;
      await publisher.publish({ ...item, nonce: digest(item.key).slice(0, 24) });
      store.mark(item.key);
    }
  };
}
