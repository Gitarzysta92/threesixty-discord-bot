import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { Events, PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import type { Client, ChatInputCommandInteraction } from 'discord.js';
import { pino } from 'pino';
import { createOpenClaw } from '../src/modules/openclaw/index.js';
import { openChannelAccessStore } from '../src/storage/channel-access-store.js';
import type { NativeChannelPolicy } from '../src/modules/openclaw/gateway.js';

const pluginUrl = new URL('../deployment/openclaw/channel-policy/index.mjs', import.meta.url).href;

test('native admission enforces exact channel access and a bounded mention window', async () => {
  const { createAdmission } = await import(pluginUrl);
  let time = 0;
  const config = { channels: { discord: { guilds: { guild: { channels: { room: { enabled: true } } } } } } };
  const policy = createAdmission({ guildId: 'guild', botId: '42', windowSeconds: 10 }, () => config, () => time);
  const context = { conversationId: 'channel:room' };
  const event = (content: string) => ({ channel: 'discord', content });
  assert.deepEqual(policy.beforeDispatch(event('ordinary chat'), context), { handled: true });
  assert.equal(policy.beforeDispatch(event('<@42> hello'), context), undefined);
  time = 9000;
  assert.equal(policy.beforeDispatch(event('why?'), context), undefined);
  time = 10000;
  assert.deepEqual(policy.beforeDispatch(event('after deadline'), context), { handled: true });
  assert.equal(policy.beforeDispatch(event('<@!42> again'), context), undefined);
  assert.deepEqual(policy.beforeDispatch(event('<@42> unknown private thread'), { conversationId: 'new-thread' }), { handled: true });
  config.channels.discord.guilds.guild.channels.room.enabled = false;
  assert.deepEqual(policy.beforeDispatch(event('<@42> disabled'), context), { handled: true });
});

test('native message tools cannot cross channels or edit/delete messages', async () => {
  const { createAdmission } = await import(pluginUrl);
  const policy = createAdmission({ guildId: 'guild', botId: '42' }, () => ({ channels: { discord: { guilds: { guild: { channels: { '123': { enabled: true }, '456': { enabled: true } } } } } } }));
  const context = { sessionKey: 'agent:discord:discord:channel:123' };
  assert.equal(policy.beforeToolCall({ toolName: 'message', params: { action: 'read', channelId: '123' } }, context), undefined);
  assert.equal(policy.beforeToolCall({ toolName: 'message', params: { action: 'send', target: 'channel:123' } }, context), undefined);
  for (const params of [{ action: 'read', channelId: '456' }, { action: 'delete', channelId: '123' }, { action: 'edit', channelId: '123' }]) {
    assert.equal(policy.beforeToolCall({ toolName: 'message', params }, context).block, true);
  }
  assert.deepEqual(policy.sending({ to: 'channel:789' }, { channelId: 'discord' }), { cancel: true });
});

test('native mode syncs channel controls and never invokes the legacy conversation handler', async () => {
  const db = openChannelAccessStore(':memory:', 'guild');
  const everyone = { id: 'guild' };
  const guild = { id: 'guild', roles: { everyone }, members: { async fetchMe() { return {}; } }, channels: {
    cache: new Map(), async fetch() {}, async fetchActiveThreads() {},
  } };
  const room = { id: '123', guild, guildId: 'guild', isTextBased: () => true, isThread: () => false,
    permissionsFor: () => new PermissionsBitField([P.ViewChannel, P.SendMessages]) };
  guild.channels.cache.set('123', room);
  const client = Object.assign(new EventEmitter(), { user: { id: '42' },
    guilds: { cache: new Map([['guild', guild]]), async fetch() { return guild; } },
    channels: { async fetch() { return room; } },
  });
  let policy: Record<string, NativeChannelPolicy> = {};
  let fail = false;
  const module = createOpenClaw(client as unknown as Client, { async reply() { assert.fail('Legacy handler must not run'); } }, {
    guildId: 'guild', channelIds: [], publicChannels: true, access: db.store,
    native: { async start() {}, async sync(_guild, channels) { if (fail) throw new Error('offline'); policy = channels; }, async stop() {} },
  }, pino({ level: 'silent' }));
  const interaction = { guildId: 'guild', guild, channelId: '123', memberPermissions: new PermissionsBitField(P.Administrator),
    options: { getChannel: () => null, getSubcommand: () => 'disable' }, async deferReply() {}, async editReply() {},
  } as unknown as ChatInputCommandInteraction;
  try {
    await module.start();
    assert.equal(client.listenerCount(Events.MessageCreate), 0);
    assert.equal(policy['123']!.enabled, true);
    assert.equal(policy['*']!.enabled, false);
    fail = true;
    await assert.rejects(module.commands[1]!.execute(interaction, { logger: pino({ level: 'silent' }) }));
    assert.equal(db.store.get('123'), undefined);
    fail = false;
    await module.commands[1]!.execute(interaction, { logger: pino({ level: 'silent' }) });
    assert.equal(policy['123']!.enabled, false);
    assert.equal(db.store.get('123'), false);
  } finally { await module.stop(); db.close(); }
});

test('policy plugin declares startup activation and registers all enforcement hooks', async () => {
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('../deployment/openclaw/channel-policy/openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.activation.onStartup, true);
  const plugin = (await import(pluginUrl)).default;
  const hooks: string[] = [];
  plugin.register({ pluginConfig: { guildId: 'guild', botId: '42' }, runtime: { config: { current: () => ({}) } }, on(name: string) { hooks.push(name); } });
  assert.deepEqual(hooks, ['before_dispatch', 'before_tool_call', 'message_sending']);
});
