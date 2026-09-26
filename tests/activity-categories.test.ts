import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelType } from 'discord.js';
import { channelCategories } from '../src/modules/activity-analysis/channel-labels.js';
import { formatSummary } from '../src/modules/activity-analysis/format.js';
import { summarize } from '../src/modules/activity-analysis/service.js';

test('category labels distinguish channels and follow thread parents, with unavailable fallbacks', async () => {
  const category = { type: ChannelType.GuildCategory, name: 'Project Alpha' };
  const normal = { isThread: () => false, parent: category };
  const channels = new Map<string, { isThread(): boolean; parent: typeof category | null }>([
    ['first', normal],
    ['second', { ...normal, parent: { ...category, name: 'Project Beta' } }],
    ['plain', { isThread: () => false, parent: null }],
  ]);
  const client = { guilds: { fetch: async () => ({ channels: { fetch: async (id?: string) => {
    if (!id) return channels;
    if (id === 'thread') return { isThread: () => true, parent: normal };
    throw new Error('Not accessible');
  } } }) } };
  const labels = await channelCategories(client as never, 'guild', ['first', 'second', 'thread', 'plain', 'deleted']);
  assert.deepEqual(labels, { first: 'Project Alpha', second: 'Project Beta', thread: 'Project Alpha', plain: 'No category', deleted: 'Unavailable category' });
  const result = summarize({ collectionStartedAt: () => 0, read: () => [
    { messageId: '1', guildId: 'guild', userId: 'u', channelId: 'first', occurredAt: 1 },
    { messageId: '2', guildId: 'guild', userId: 'u', channelId: 'second', occurredAt: 1 },
  ] }, 'guild', 0, 2);
  const content = formatSummary(result, 'Activity summary', undefined, labels);
  assert.match(content, /Project Alpha \/ <#first>: 1/);
  assert.match(content, /Project Beta \/ <#second>: 1/);
});
