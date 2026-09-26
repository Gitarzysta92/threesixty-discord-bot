import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openActivityStore } from '../src/storage/activity-store.js';
import { createHistoryRefresher, missingRanges, snowflakeBefore } from '../src/modules/activity-collector/history.js';
import type { HistoryMessage, HistorySource } from '../src/modules/activity-collector/history.js';
import { summarize } from '../src/modules/activity-analysis/service.js';

const from = Date.UTC(2026, 8, 1);
function message(timestamp: number, sequence: number): HistoryMessage {
  const id = (BigInt(snowflakeBefore(timestamp)) + BigInt(sequence)).toString();
  return { id, timestamp, activity: { messageId: id, occurredAt: timestamp, guildId: 'g', channelId: 'c', userId: 'u' } };
}
function source(messages: HistoryMessage[], requests: string[]): HistorySource {
  return {
    async channels() { return { ids: ['c'], skipped: 0, incomplete: false }; },
    async messages(_, before) {
      requests.push(before);
      return messages.filter(m => BigInt(m.id) < BigInt(before)).sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, 100);
    },
  };
}
test('history fills gaps before live collection, handles same-millisecond pagination, and reuses completed scans', async () => {
  const store = openActivityStore(':memory:', from + 1000);
  const messages = Array.from({ length: 150 }, (_, i) => message(from, i));
  const requests: string[] = [];
  const refresh = createHistoryRefresher(source(messages, requests), store.writer, store.coverage, 'g');
  try {
    store.writer.record(messages[0]!.activity!); // Already received live, do not double count.
    assert.equal((await refresh.refresh(from, from + 1000)).checked, 1);
    assert.equal(summarize(store.reader, 'g', from, from + 1000).messages, 150);
    assert.equal(requests.length, 2);
    await refresh.refresh(from, from + 1000);
    assert.equal(requests.length, 2);
    messages.push(message(from + 1100, 1));
    await refresh.refresh(from, from + 2000);
    assert.equal(requests.length, 3);
    assert.equal(summarize(store.reader, 'g', from, from + 2000).messages, 151);
    assert.deepEqual(store.coverage.ranges('g', 'c'), [{ from, until: from + 2000 }]);
  } finally { await refresh.stop(); store.close(); }
});
test('failed pages preserve only verified coverage, and a retry resumes without losing boundary messages', async () => {
  const store = openActivityStore(':memory:');
  const messages = Array.from({ length: 220 }, (_, i) => message(from + i, 0));
  const requests: string[] = [];
  const input = source(messages, requests);
  const fetch = input.messages;
  let calls = 0;
  input.messages = async (...args) => { if (++calls === 2) throw new Error('network'); return fetch(...args); };
  let refresh = createHistoryRefresher(input, store.writer, store.coverage, 'g');
  try {
    assert.equal((await refresh.refresh(from, from + 1000)).incomplete, 1);
    assert.deepEqual(store.coverage.ranges('g', 'c'), [{ from: from + 121, until: from + 1000 }]);
    await refresh.stop();
    refresh = createHistoryRefresher(source(messages, requests), store.writer, store.coverage, 'g');
    assert.equal((await refresh.refresh(from, from + 1000)).incomplete, 0);
    assert.equal(summarize(store.reader, 'g', from, from + 1000).messages, 220);
    store.writer.prune(from + 100);
    assert.deepEqual(store.coverage.ranges('g', 'c'), [{ from: from + 100, until: from + 1000 }]);
  } finally { await refresh.stop(); store.close(); }
});
test('missing ranges handle overlapping coverage; channel errors and discovery gaps are reported', async () => {
  assert.deepEqual(missingRanges(0, 100, [{ from: 20, until: 40 }, { from: 30, until: 80 }]), [{ from: 0, until: 20 }, { from: 80, until: 100 }]);
  const store = openActivityStore(':memory:');
  const refresh = createHistoryRefresher({
    async channels() { return { ids: ['empty', 'denied'], skipped: 2, incomplete: true }; },
    async messages(channel) { if (channel === 'denied') throw new Error('403'); return []; },
  }, store.writer, store.coverage, 'g');
  try {
    assert.deepEqual(await refresh.refresh(from, from + 100), { checked: 1, incomplete: 3, discoveryIncomplete: true });
    assert.deepEqual(store.coverage.ranges('g', 'denied'), []);
  } finally { await refresh.stop(); store.close(); }
});
test('concurrent refresh is rejected and shutdown aborts the active request', async () => {
  const store = openActivityStore(':memory:');
  const refresh = createHistoryRefresher({
    async channels() { return { ids: ['c'], skipped: 0, incomplete: false }; },
    async messages(_, __, signal) { return new Promise((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); },
  }, store.writer, store.coverage, 'g');
  const active = refresh.refresh(from, from + 100);
  await assert.rejects(refresh.refresh(from, from + 100), /already running/);
  await refresh.stop();
  assert.equal((await active).incomplete, 1);
  store.close();
});

test('manual command waits for refresh and reports the full requested historical window', async () => {
  const { createAnalysis } = await import('../src/modules/activity-analysis/index.js');
  const store = openActivityStore(':memory:', Date.now());
  const replies: string[] = [];
  let queried = false;
  const module = createAnalysis({
    ...store.reader,
    *read(...args) { queried = true; yield* store.reader.read(...args); },
  }, 'g', 90, undefined, {
    async refresh(start, end) {
      assert.equal(queried, false);
      assert.equal(end - start, 7 * 86400000);
      store.writer.record({ messageId: 'historical', guildId: 'g', channelId: 'c', userId: 'u', occurredAt: start + 1000 });
      return { checked: 1, incomplete: 2, discoveryIncomplete: false };
    },
    async stop() {},
  });
  try {
    await module.commands[0]!.execute({
      async deferReply() {},
      options: { getInteger: () => 7 },
      async editReply(value: string | { content: string }) { replies.push(typeof value === 'string' ? value : value.content); },
    } as never, {} as never);
    assert.match(replies.at(-1)!, /Messages: \*\*1\*\*/);
    assert.match(replies.at(-1)!, /Partial coverage/);
  } finally { await module.stop?.(); store.close(); }
});

test('Discord adapter discovers archived threads, excludes parents, and filters non-human messages', async () => {
  const { discordHistorySource } = await import('../src/modules/activity-collector/discord-history.js');
  const { ChannelType, PermissionFlagsBits } = await import('discord.js');
  const calls: string[] = [];
  const channel = (id: string, allowed: boolean) => ({ id, type: ChannelType.GuildText, parentId: null, isTextBased: () => true,
    permissionsFor: () => ({ has: (p: unknown) => p === PermissionFlagsBits.ManageThreads ? false : allowed }) });
  const input = discordHistorySource({
    guilds: { fetch: async () => ({ members: { fetchMe: async () => ({}) }, channels: { fetch: async () => new Map([
      ['c', channel('c', true)], ['excluded', channel('excluded', true)], ['denied', channel('denied', false)],
    ]) } }) },
    rest: { get: async (path: string, options: { query?: URLSearchParams }) => {
      calls.push(path);
      if (path.endsWith('/messages')) return [
        { id: '1', timestamp: new Date(from).toISOString(), type: 0, author: { id: 'u' } },
        { id: '2', timestamp: new Date(from).toISOString(), type: 0, author: { id: 'b', bot: true } },
        { id: '3', timestamp: new Date(from).toISOString(), type: 7, author: { id: 'u' } },
      ];
      if (path.includes('/active')) return { threads: [{ id: 'active', parent_id: 'c' }, { id: 'hidden', parent_id: 'excluded' }] };
      if (path.endsWith('/public') && !options.query?.get('before')) return { threads: [{ id: 'archived1', parent_id: 'c', thread_metadata: { archive_timestamp: '2026-09-01T00:00:00.000Z' } }], has_more: true };
      return { threads: [{ id: path.endsWith('/private') ? 'private' : 'archived2', parent_id: 'c' }], has_more: false };
    } },
  } as never, { guildId: 'g', excludedChannelIds: ['excluded'], retentionDays: 90 });
  const result = await input.channels(new AbortController().signal);
  assert.deepEqual(result, { ids: ['c', 'active', 'archived1', 'archived2', 'private'], incomplete: false, skipped: 1 });
  assert.ok(calls.includes('/channels/c/users/@me/threads/archived/private'));
  assert.equal(calls.some(path => path.includes('excluded')), false);
  assert.deepEqual((await input.messages('c', '100', new AbortController().signal)).map(m => !!m.activity), [true, false, false]);
});
