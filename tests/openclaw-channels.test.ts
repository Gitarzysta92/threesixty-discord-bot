import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import type { Client, Message, ChatInputCommandInteraction } from 'discord.js';
import { pino } from 'pino';
import { openChannelAccessStore } from '../src/storage/channel-access-store.js';
import { createOpenClaw, isAllowedMessage } from '../src/modules/openclaw/index.js';

const logger = pino({ level: 'silent' });
test('channel overrides persist, isolate guilds and reset to defaults', () => {
  const directory = mkdtempSync(join(tmpdir(), 'claw-access-'));
  const path = join(directory, 'settings.sqlite');
  try {
    const first = openChannelAccessStore(path, 'guild');
    first.store.set('allowed', true); first.store.set('denied', false); first.close();
    const second = openChannelAccessStore(path, 'guild');
    assert.equal(second.store.get('allowed'), true);
    assert.equal(second.store.get('denied'), false);
    second.store.reset('allowed'); assert.equal(second.store.get('allowed'), undefined);
    second.close();
    const other = openChannelAccessStore(path, 'other');
    assert.equal(other.store.get('denied'), undefined); other.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('overrides supersede public and environment defaults; threads inherit unless overridden', () => {
  const db = openChannelAccessStore(':memory:', 'guild');
  try {
    const config = { guildId: 'guild', channelIds: ['room'], publicChannels: true, access: db.store };
    const message = { guildId: 'guild', channelId: 'room', author: { bot: false }, channel: { isThread: () => false } } as unknown as Message;
    assert.equal(isAllowedMessage(message, config), true);
    db.store.set('room', false); assert.equal(isAllowedMessage(message, config), false);
    const thread = { ...message, channelId: 'thread', channel: { isThread: () => true, parentId: 'room' } } as unknown as Message;
    assert.equal(isAllowedMessage(thread, config), false);
    db.store.set('thread', true); assert.equal(isAllowedMessage(thread, config), true);
    db.store.reset('thread'); assert.equal(isAllowedMessage(thread, config), false);
    db.store.set('room', true); assert.equal(isAllowedMessage(thread, config), true);
    assert.equal(isAllowedMessage({ ...message, guildId: 'other' } as Message, config), false);
  } finally { db.close(); }
});

test('admin command controls live slash and mention access without changing defaults', async () => {
  const db = openChannelAccessStore(':memory:', 'guild');
  const guild = { roles: { everyone: { id: 'guild' } }, members: { async fetchMe() { return {}; } } };
  const channel = { id: 'room', guildId: 'guild', guild, isThread: () => false, isTextBased: () => true,
    permissionsFor: (member: { id?: string }) => new PermissionsBitField(member.id === 'guild' ? 0n : [P.ViewChannel, P.SendMessages]) };
  const client = Object.assign(new EventEmitter(), { user: { id: 'bot' }, channels: { async fetch() { return channel; } } });
  let requests = 0;
  const module = createOpenClaw(client as unknown as Client, { async reply() { requests++; return 'answer'; } },
    { guildId: 'guild', channelIds: [], publicChannels: true, access: db.store }, logger);
  const replies: string[] = [];
  const interaction = (action: string, admin = true, guildId = 'guild') => ({
    guildId, guild, channelId: 'room', channel, user: { id: 'human' },
    memberPermissions: new PermissionsBitField(admin ? P.Administrator : 0n),
    options: { getChannel: () => null, getSubcommand: () => action, getString: () => 'hello' },
    async reply(p: { content: string }) { replies.push(p.content); },
    async deferReply() {}, async editReply(p: string | { content: string }) { replies.push(typeof p === 'string' ? p : p.content); },
  }) as unknown as ChatInputCommandInteraction;
  const command = module.commands[1]!;
  try {
    await module.start();
    await command.execute(interaction('enable', false), { logger });
    await command.execute(interaction('enable', true, 'other'), { logger });
    assert.equal(db.store.get('room'), undefined);
    await module.commands[0]!.execute(interaction(''), { logger }); assert.equal(requests, 0);
    await command.execute(interaction('enable'), { logger }); assert.equal(db.store.get('room'), true);
    await module.commands[0]!.execute(interaction(''), { logger }); assert.equal(requests, 1);
    const message = { guildId: 'guild', guild, channelId: 'room', channel, author: { bot: false } } as unknown as Message;
    assert.equal(isAllowedMessage(message, { guildId: 'guild', channelIds: [], access: db.store }), true);
    await command.execute(interaction('disable'), { logger });
    await module.commands[0]!.execute(interaction(''), { logger }); assert.equal(requests, 1);
    await command.execute(interaction('status'), { logger }); assert.match(replies.at(-1)!, /disabled/);
    await command.execute(interaction('reset'), { logger }); assert.equal(db.store.get('room'), undefined);
    assert.match(replies.at(-1)!, /disabled.*inherited/);
  } finally { await module.stop(); db.close(); }
});
