import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, Client, GatewayIntentBits, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { pino } from 'pino';
import { openDestinationStore } from '../src/storage/destination-store.js';
import { DestinationController } from '../src/core/destination.js';
import { createDestinationCommand, destinationCommandData } from '../src/core/destination-command.js';
import { composeModules } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { resetsCommandData } from '../src/modules/reset-announcements/index.js';
import { activityCommandData, summaryCommandData } from '../src/modules/activity-analysis/index.js';

const logger = pino({ level: 'silent' });
test('destinations and explicit disable survive restart and remain isolated by module and guild', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'destination-test-'));
  const path = join(directory, 'settings.sqlite');
  let db = openDestinationStore(path);
  try {
    const controller = new DestinationController(db.forModule('company', 'resets'));
    let posts = 0;
    await controller.deliver(async () => { posts++; });
    assert.equal(posts, 0);
    await controller.configure('news', 100);
    await controller.configure('news', 200);
    assert.deepEqual(controller.read(), { channelId: 'news', enabledAt: 100 });
    assert.equal(db.forModule('company', 'summary').get(), null);
    assert.equal(db.forModule('other', 'resets').get(), null);
    db.close(); db = openDestinationStore(path);
    const restored = new DestinationController(db.forModule('company', 'resets'));
    assert.deepEqual(restored.read(), { channelId: 'news', enabledAt: 100 });
    await restored.configure(null, 300);
    db.close(); db = openDestinationStore(path);
    assert.equal(db.forModule('company', 'resets').get(), null);
    await new DestinationController(db.forModule('company', 'resets')).configure('reports', 400);
    assert.deepEqual(db.forModule('company', 'resets').get(), { channelId: 'reports', enabledAt: 400 });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('configuration waits for in-flight sends and subsequent delivery uses the new channel', async () => {
  const db = openDestinationStore(':memory:');
  try {
    const controller = new DestinationController(db.forModule('company', 'resets'));
    await controller.configure('old');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const posts: string[] = [];
    const delivery = controller.deliver(async destination => { await gate; posts.push(destination.channelId); });
    let saved = false;
    const change = controller.configure('new').then(() => { saved = true; });
    await Promise.resolve();
    assert.equal(saved, false);
    release(); await delivery; await change;
    await controller.deliver(async destination => { posts.push(destination.channelId); });
    assert.deepEqual(posts, ['old', 'new']);
    await assert.rejects(controller.deliver(async () => { throw new Error('send failed'); }));
    await controller.configure(null);
    await controller.deliver(async () => { assert.fail('disabled destination must not send'); });
  } finally { db.close(); }
});

test('Discord configuration validates administrator, guild, channel type and bot permissions before saving', async () => {
  const db = openDestinationStore(':memory:');
  const controller = new DestinationController(db.forModule('company', 'resets'));
  let guildId = 'company';
  let channelType = ChannelType.GuildText;
  let canSend = true;
  let memberPermissions = new PermissionsBitField(PermissionFlagsBits.Administrator);
  let selected: string | null = null;
  let subcommand = 'enable';
  const fetched: string[] = [];
  const replies: string[] = [];
  const fakeClient = { channels: { async fetch(id: string) {
    fetched.push(id);
    return { id, guildId, type: channelType, guild: { members: { async fetchMe() { return {}; } } }, permissionsFor() { return { has: () => canSend }; } };
  } } } as unknown as Client;
  const interaction = {
    guildId: 'company', channelId: 'current',
    get memberPermissions() { return memberPermissions; },
    options: { getSubcommand: () => subcommand, getChannel: () => selected ? { id: selected } : null },
    async deferReply() {}, async editReply(value: string) { replies.push(value); },
  } as unknown as ChatInputCommandInteraction;
  const command = createDestinationCommand(destinationCommandData('resets', 'Reset settings'), fakeClient, 'company', controller, 'Every 5 minutes.');
  try {
    memberPermissions = new PermissionsBitField();
    await command.execute(interaction, { logger });
    assert.equal(controller.read(), null); assert.equal(fetched.length, 0);
    memberPermissions = new PermissionsBitField(PermissionFlagsBits.Administrator);
    guildId = 'foreign'; await command.execute(interaction, { logger }); assert.equal(controller.read(), null);
    guildId = 'company'; channelType = ChannelType.GuildVoice; await command.execute(interaction, { logger }); assert.equal(controller.read(), null);
    channelType = ChannelType.GuildText; canSend = false; await command.execute(interaction, { logger }); assert.equal(controller.read(), null);
    canSend = true; await command.execute(interaction, { logger }); assert.equal(controller.read()?.channelId, 'current');
    selected = 'reports'; await command.execute(interaction, { logger }); assert.equal(controller.read()?.channelId, 'reports');
    subcommand = 'status'; await command.execute(interaction, { logger }); assert.match(replies.at(-1)!, /reports/);
    subcommand = 'disable'; await command.execute(interaction, { logger }); assert.equal(controller.read(), null);
  } finally { db.close(); }
});

test('runtime exposes configuration commands without channel environment variables', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dynamic-modules-'));
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const app = composeModules(client, loadConfig({ DATA_DIR: directory, DISCORD_TOKEN: 'test-only', DISCORD_APPLICATION_ID: '123456789012345678', DISCORD_GUILD_ID: '123456789012345678' }), logger);
  try {
    const commands = app.modules.flatMap(module => [...module.commands]);
    for (const definition of [resetsCommandData, summaryCommandData, activityCommandData]) {
      assert.deepEqual(commands.find(command => command.data.name === definition.name)?.data.toJSON(), definition.toJSON());
    }
  } finally { app.close(); await client.destroy(); rmSync(directory, { recursive: true, force: true }); }
});
