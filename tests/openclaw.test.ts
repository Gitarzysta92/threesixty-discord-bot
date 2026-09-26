import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { ChannelType, Events, GatewayIntentBits, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import type { ChatInputCommandInteraction, Client, Message } from 'discord.js';
import { pino } from 'pino';
import { loadConfig } from '../src/config.js';
import { createOpenClawClient } from '../src/modules/openclaw/api.js';
import type { ConversationRequest, OpenClawClient } from '../src/modules/openclaw/api.js';
import { createOpenClaw, isAllowedMessage, replyChunks } from '../src/modules/openclaw/index.js';

const guildId = '123456789012345678';
const channelId = '223456789012345678';
const botId = '323456789012345678';
const env = { DISCORD_TOKEN: 'discord-secret', DISCORD_APPLICATION_ID: botId, DISCORD_GUILD_ID: guildId };
const logger = pino({ level: 'silent' });

function fixture(agent?: OpenClawClient) {
  const client = Object.assign(new EventEmitter(), { user: { id: botId } });
  const requests: ConversationRequest[] = [];
  const replies: { content: string; allowedMentions: { parse: string[]; repliedUser: boolean } }[] = [];
  const module = createOpenClaw(client as unknown as Client, agent ?? { async reply(input) { requests.push(input); return 'An answer'; } }, { guildId, channelIds: [channelId] }, logger);
  const message = (overrides: Record<string, unknown> = {}) => ({
    id: 'message', guildId, channelId, author: { id: 'human', bot: false }, webhookId: null, system: false,
    content: `<@${botId}> Hello`, channel: { isThread: () => false, async sendTyping() {} },
    async reply(payload: typeof replies[number]) { replies.push(payload); },
    ...overrides,
  }) as unknown as Message;
  return { client, requests, replies, module, message, async emit(overrides: Record<string, unknown> = {}) {
    client.emit(Events.MessageCreate, message(overrides)); await setImmediate();
  } };
}

test('OpenClaw config is opt-in and validates required settings without exposing secrets', () => {
  assert.equal(loadConfig(env).OPENCLAW_ENABLED, false);
  assert.throws(() => loadConfig({ ...env, OPENCLAW_ENABLED: 'true' }), /OPENCLAW_TOKEN/);
  const config = loadConfig({ ...env, OPENCLAW_ENABLED: 'true', OPENCLAW_TOKEN: 'gateway-secret', OPENCLAW_CHANNEL_IDS: channelId });
  assert.deepEqual(config.OPENCLAW_CHANNEL_IDS, [channelId]);
  assert.equal(loadConfig({ ...env, OPENCLAW_ENABLED: 'true', OPENCLAW_TOKEN: 'gateway-secret', OPENCLAW_PUBLIC_CHANNELS: 'true' }).OPENCLAW_PUBLIC_CHANNELS, true);
  assert.throws(() => loadConfig({ ...env, OPENCLAW_BASE_URL: 'https://secret@example.com/v1' }), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes('secret@')); return true;
  });
  assert.throws(() => loadConfig({ ...env, OPENCLAW_TIMEOUT_SECONDS: '0' }), /OPENCLAW_TIMEOUT_SECONDS/);
});

test('all-public mode follows everyone visibility and excludes private channels and threads', () => {
  const f = fixture();
  const config = { guildId, channelIds: [], publicChannels: true };
  const guild = { roles: { everyone: { id: guildId } } };
  const publicParent = { permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.ViewChannel) };
  const privateParent = { permissionsFor: () => new PermissionsBitField() };
  assert.equal(isAllowedMessage(f.message({ guild, channel: { isThread: () => false, ...publicParent } }), config), true);
  assert.equal(isAllowedMessage(f.message({ guild, channel: { isThread: () => false, ...privateParent } }), config), false);
  assert.equal(isAllowedMessage(f.message({ guild, channel: { isThread: () => true, parent: publicParent, type: ChannelType.PublicThread } }), config), true);
  assert.equal(isAllowedMessage(f.message({ guild, channel: { isThread: () => true, parent: publicParent, type: ChannelType.PrivateThread } }), config), false);
  assert.equal(isAllowedMessage(f.message({ guild, channel: { isThread: () => true, parent: privateParent, type: ChannelType.PublicThread } }), config), false);
  assert.equal(isAllowedMessage(f.message({ guild, channel: { isThread: () => true, parent: null } }), config), false);
  assert.equal(isAllowedMessage(f.message({ guild, guildId: 'other', channel: { isThread: () => false, ...publicParent } }), config), false);
});

test('only addressed human messages in allowed guild channels or threads reach OpenClaw', async () => {
  const f = fixture(); await f.module.start();
  assert.ok(f.module.intents.includes(GatewayIntentBits.MessageContent));
  for (const overrides of [
    { guildId: null }, { guildId: 'other' }, { channelId: 'other' },
    { author: { id: 'other-bot', bot: true } }, { webhookId: 'webhook' }, { system: true },
    { content: 'ordinary conversation' }, { content: '@everyone hello' },
  ]) await f.emit(overrides);
  assert.equal(f.requests.length, 0);
  await f.emit();
  await f.emit({ channelId: 'thread', channel: { isThread: () => true, parentId: channelId } });
  assert.equal(f.requests.length, 2);
  assert.notEqual(f.requests[0]!.session, f.requests[1]!.session);
  assert.equal(JSON.parse(f.requests[0]!.content).message, 'Hello');
  assert.deepEqual(f.replies[0]!.allowedMentions, { parse: [], repliedUser: false });
  await f.module.stop();
  await f.emit(); assert.equal(f.requests.length, 2);
  assert.equal(f.client.listenerCount(Events.MessageCreate), 0);
});

test('replies to this bot continue a session; other and cross-channel replies do not', async () => {
  const f = fixture(); await f.module.start();
  await f.emit();
  await f.emit({ content: 'Explain more', reference: { messageId: 'previous', channelId },
    async fetchReference() { return { author: { id: botId }, content: 'Prior answer' }; } });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0]!.session, f.requests[1]!.session);
  assert.equal(JSON.parse(f.requests[1]!.content).replyTo.message, 'Prior answer');
  await f.emit({ content: 'Human reply', reference: { messageId: 'previous', channelId },
    async fetchReference() { return { author: { id: 'human' }, content: 'Private' }; } });
  await f.emit({ content: 'Cross-channel reply', reference: { messageId: 'previous', channelId: 'other' },
    async fetchReference() { assert.fail('Must not fetch another channel'); } });
  await f.emit({ content: 'Deleted reply', reference: { messageId: 'previous', channelId },
    async fetchReference() { throw new Error('Missing message'); } });
  assert.equal(f.requests.length, 2);
  await f.module.stop();
});

test('concurrency is bounded and shutdown cancels active requests without posting errors', async () => {
  let calls = 0;
  const f = fixture({ reply(_input, signal) {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  await f.module.start(); await f.module.start();
  await f.emit(); await f.emit();
  for (let i = 0; i < 5; i++) await f.emit({ channelId: `thread-${i}`, channel: { isThread: () => true, parentId: channelId } });
  assert.equal(calls, 4);
  await f.module.stop();
  assert.equal(f.replies.length, 0);
});

test('failed requests produce a generic response and release the conversation for retry', async () => {
  let calls = 0;
  const f = fixture({ async reply() { if (++calls === 1) throw new Error('provider-secret'); return 'Recovered'; } });
  await f.module.start(); await f.emit(); await f.emit(); await f.module.stop();
  assert.match(f.replies[0]!.content, /try again/);
  assert.ok(!f.replies[0]!.content.includes('provider-secret'));
  assert.equal(f.replies[1]!.content, 'Recovered');
});

test('HTTP adapter authenticates, selects the agent and preserves conversation identity', async () => {
  const agent = createOpenClawClient({ baseUrl: 'http://localhost:18789/v1/', token: 'secret', agentId: 'discord', timeoutMs: 1000 }, async (url, options) => {
    assert.equal(url, 'http://localhost:18789/v1/chat/completions');
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer secret');
    assert.deepEqual(JSON.parse(options!.body as string), { model: 'openclaw/discord', user: 'room', stream: false, messages: [{ role: 'user', content: 'hello' }] });
    return Response.json({ choices: [{ message: { content: ' answer ' } }] });
  });
  assert.equal(await agent.reply({ session: 'room', content: 'hello' }, new AbortController().signal), 'answer');
});

test('HTTP failures and malformed responses are sanitized; requests time out', async () => {
  for (const response of [new Response('secret', { status: 401 }), Response.json({ choices: [] }), Response.json({ choices: [{ message: { content: null } }] })]) {
    const agent = createOpenClawClient({ baseUrl: 'http://localhost/v1', token: 'secret', agentId: 'discord', timeoutMs: 1000 }, async () => response);
    await assert.rejects(agent.reply({ session: 'room', content: 'private' }, new AbortController().signal), { message: 'OpenClaw request failed or timed out' });
  }
  const agent = createOpenClawClient({ baseUrl: 'http://localhost/v1', token: 'secret', agentId: 'discord', timeoutMs: 10 }, async (_url, options) => new Promise((_resolve, reject) => {
    // Keep the event loop alive while the unref'ed AbortSignal timer expires.
    const keepAlive = setTimeout(() => reject(new Error('Timeout did not abort')), 1000);
    options!.signal!.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new Error('secret')); });
  }));
  await assert.rejects(agent.reply({ session: 'room', content: 'private' }, new AbortController().signal), { message: 'OpenClaw request failed or timed out' });
});

test('long replies fit Discord limits, preserve emoji boundaries, and cap output', () => {
  const text = `${'x'.repeat(1999)}😀${'y'.repeat(2100)}`;
  const chunks = replyChunks(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => chunk.length <= 2000 && !/[\uD800-\uDBFF]$/.test(chunk)));
  assert.equal(replyChunks('x'.repeat(10000)).length, 4);
  assert.match(replyChunks('x'.repeat(10000)).join(''), /Response shortened/);
  const cappedEmoji = replyChunks(`${'x'.repeat(7899)}😀${'y'.repeat(2000)}`);
  assert.equal(cappedEmoji.length, 4);
  assert.ok(!cappedEmoji.join('').includes('\uD83D'));
});

function slash(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const events: { kind: string; content?: string; flags?: number; allowedMentions?: unknown }[] = [];
  const interaction = {
    guildId, guild: null, channelId, channel: f.message().channel, user: { id: 'human' },
    options: { getString: () => ' Hello ' },
    async deferReply() { events.push({ kind: 'defer' }); },
    async reply(data: object) { events.push({ kind: 'reply', ...data }); },
    async editReply(data: object) { events.push({ kind: 'edit', ...data }); },
    async followUp(data: object) { events.push({ kind: 'follow', ...data }); },
    ...overrides,
  } as unknown as ChatInputCommandInteraction;
  return { events, run: () => f.module.commands[0]!.execute(interaction, { logger }) };
}

test('/tclaw defers, shares the message session, and splits replies without mentions', async () => {
  const f = fixture(); await f.module.start();
  const command = slash(f); await command.run(); await f.emit();
  assert.equal(f.module.commands[0]!.data.name, 'tclaw');
  assert.equal(f.requests[0]!.session, f.requests[1]!.session);
  assert.equal(JSON.parse(f.requests[0]!.content).message, 'Hello');
  assert.deepEqual(command.events.map(e => e.kind), ['defer', 'edit']);
  await f.module.stop();
  const long = fixture({ async reply() { return 'x'.repeat(4500); } }); await long.module.start();
  const chunks = slash(long); await chunks.run();
  assert.deepEqual(chunks.events.map(e => e.kind), ['defer', 'edit', 'follow', 'follow']);
  assert.ok(chunks.events.slice(1).every(e => e.content!.length <= 2000));
  assert.deepEqual(chunks.events[1]!.allowedMentions, { parse: [], repliedUser: false });
  await long.module.stop();
});

test('/tclaw rejects disallowed channels and empty input without querying the agent', async () => {
  const f = fixture(); await f.module.start();
  for (const overrides of [{ channelId: 'private' }, { guildId: 'other' }, { channel: null }, { options: { getString: () => '   ' } }]) {
    const command = slash(f, overrides); await command.run();
    assert.equal(command.events[0]!.kind, 'reply');
    assert.equal(command.events[0]!.flags, 64);
  }
  assert.equal(f.requests.length, 0); await f.module.stop();
});

test('/tclaw shares concurrency limits and cancels on shutdown', async () => {
  let calls = 0;
  const f = fixture({ reply(_input, signal) {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  await f.module.start();
  const first = slash(f); const pending = first.run();
  const second = slash(f); await second.run(); await f.emit();
  assert.match(second.events[0]!.content!, /busy/);
  assert.equal(calls, 1);
  await f.module.stop(); await pending;
  assert.deepEqual(first.events.map(e => e.kind), ['defer']);
});

test('/tclaw sanitizes failures and releases its channel for retry', async () => {
  let calls = 0;
  const f = fixture({ async reply() { if (++calls === 1) throw new Error('secret'); return 'Recovered'; } });
  await f.module.start();
  const first = slash(f); await first.run();
  assert.match(first.events[1]!.content!, /try again/);
  assert.ok(!first.events[1]!.content!.includes('secret'));
  const second = slash(f); await second.run();
  assert.equal(second.events[1]!.content, 'Recovered');
  await f.module.stop();
});
