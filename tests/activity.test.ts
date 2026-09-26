import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openActivityStore } from '../src/storage/activity-store.js';
import { summarize } from '../src/modules/activity-analysis/service.js';
import { toActivity } from '../src/modules/activity-collector/index.js';
import { loadFeatures } from '../src/config.js';

const day = 86_400_000;
const start = Date.UTC(2026, 8, 1);

test('durable collection is idempotent; analysis counts unique members and UTC days', () => {
  const directory = mkdtempSync(join(tmpdir(), 'activity-test-'));
  const path = join(directory, 'activity.sqlite');
  let store = openActivityStore(path, start);
  try {
    const event = { messageId: '1', guildId: 'company', userId: 'alice', channelId: 'general', occurredAt: start };
    store.writer.record(event);
    store.writer.record(event);
    store.writer.record({ ...event, messageId: '2', occurredAt: start + day, channelId: 'engineering' });
    store.writer.record({ ...event, messageId: '3', userId: 'bob', occurredAt: start + day });
    store.writer.record({ ...event, messageId: '4', guildId: 'other' });
    store.writer.record({ ...event, messageId: '5', occurredAt: start + 2 * day });
    store.close();
    store = openActivityStore(path, start + day);
    const report = summarize(store.reader, 'company', start, start + 2 * day);
    assert.equal(report.messages, 3);
    assert.equal(report.activeMembers, 2);
    assert.equal(report.collectionStartedAt, start);
    assert.deepEqual(report.days.map(item => item.count), [1, 2]);
    assert.deepEqual(report.channels, [{ id: 'general', count: 2 }, { id: 'engineering', count: 1 }]);
    store.writer.prune(start + day);
    assert.equal(summarize(store.reader, 'company', start, start + 2 * day).messages, 2);
    assert.equal(summarize(store.reader, 'empty', start, start + day).activeMembers, 0);
    assert.throws(() => summarize(store.reader, 'company', start, start), /Invalid/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('collector filters bots, webhooks, system messages, other guilds and excluded thread parents', () => {
  const config = { guildId: 'company', excludedChannelIds: ['private'], retentionDays: 90 };
  const base = { id: '1', guildId: 'company', channelId: 'general', author: { id: 'alice', bot: false }, webhookId: null, system: false, createdTimestamp: start, channel: { parentId: null } };
  const convert = (value: unknown) => toActivity(value as Parameters<typeof toActivity>[0], config);
  assert.deepEqual(convert(base), { messageId: '1', guildId: 'company', channelId: 'general', userId: 'alice', occurredAt: start });
  for (const change of [{ author: { bot: true } }, { webhookId: 'hook' }, { system: true }, { guildId: null }, { guildId: 'other' }, { channelId: 'private' }, { channel: { parentId: 'private' } }]) {
    assert.equal(convert({ ...base, ...change }), null);
  }
});

test('feature flags are independent and configuration rejects unsafe polling intervals', () => {
  const config = loadFeatures({ ACTIVITY_COLLECTOR_ENABLED: 'false', ACTIVITY_ANALYSIS_ENABLED: 'true' });
  assert.equal(config.ACTIVITY_COLLECTOR_ENABLED, false);
  assert.equal(config.ACTIVITY_ANALYSIS_ENABLED, true);
  assert.equal(loadFeatures({ RESETS_CHANNEL_ID: '' }).RESETS_CHANNEL_ID, undefined);
  assert.throws(() => loadFeatures({ RESETS_POLL_SECONDS: '0' }));
  assert.throws(() => loadFeatures({ ACTIVITY_COLLECTOR_ENABLED: 'yes' }));
});
