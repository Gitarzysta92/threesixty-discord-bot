import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageFlags, PermissionFlagsBits, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { pino } from 'pino';
import { loadConfig } from '../src/config.js';
import { createRegistry } from '../src/core/command.js';
import type { Command } from '../src/core/command.js';
import { dispatch } from '../src/core/dispatch.js';
import { canExecute } from '../src/core/permissions.js';

const guildId = '123456789012345678';
const logger = pino({ level: 'silent' });
const validEnv = { DISCORD_TOKEN: 'secret-for-test', DISCORD_APPLICATION_ID: guildId, DISCORD_GUILD_ID: guildId };

test('configuration validates IDs and never echoes the token', () => {
  assert.equal(loadConfig(validEnv).LOG_LEVEL, 'info');
  assert.throws(() => loadConfig({ ...validEnv, DISCORD_GUILD_ID: 'invalid' }), /DISCORD_GUILD_ID/);
  assert.throws(() => loadConfig({ ...validEnv, LOG_LEVEL: 'invalid' }), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(validEnv.DISCORD_TOKEN));
    return true;
  });
  assert.throws(() => loadConfig({}), /Invalid configuration/);
});

test('permissions include administrator override and disabled-by-default commands', () => {
  const admin = new PermissionsBitField(PermissionFlagsBits.Administrator);
  const member = new PermissionsBitField();
  assert.equal(canExecute(undefined, null), true);
  assert.equal(canExecute('0', admin), true);
  assert.equal(canExecute('0', member), false);
  assert.equal(canExecute(String(PermissionFlagsBits.ManageGuild), admin), true);
  assert.equal(canExecute(String(PermissionFlagsBits.ManageGuild), member), false);
  assert.equal(canExecute(String(PermissionFlagsBits.ManageGuild), null), false);
});

function fixture(options: { guildId?: string | null; permissions?: bigint; deferred?: boolean; replied?: boolean; replyFails?: boolean } = {}) {
  const calls: { method: string; payload: unknown }[] = [];
  const capture = (method: string) => async (payload: unknown) => {
    calls.push({ method, payload });
    if (options.replyFails) throw new Error('Expired interaction');
  };
  const interaction = {
    id: 'interaction', commandName: 'test', guildId,
    memberPermissions: new PermissionsBitField(options.permissions ?? 0n),
    deferred: false, replied: false,
    ...options,
    reply: capture('reply'), editReply: capture('editReply'), followUp: capture('followUp'),
  } as unknown as ChatInputCommandInteraction;
  return { interaction, calls };
}

function command(execute: Command['execute'], restricted = false): Command {
  const data = new SlashCommandBuilder().setName('test').setDescription('Test command');
  if (restricted) data.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  return { data, execute };
}

test('registry rejects duplicate command names', () => {
  const item = command(async () => {});
  assert.throws(() => createRegistry([item, item]), /Duplicate command/);
});

test('dispatcher blocks other servers and direct messages before execution', async () => {
  let executions = 0;
  const registry = createRegistry([command(async () => { executions++; })]);
  for (const id of [null, '999999999999999999']) {
    const { interaction, calls } = fixture({ guildId: id });
    await dispatch(interaction, registry, guildId, logger);
    assert.equal(calls.length, 1);
    assert.equal((calls[0]?.payload as { flags: number }).flags, MessageFlags.Ephemeral);
  }
  assert.equal(executions, 0);
});

test('dispatcher checks permissions and executes authorized commands', async () => {
  let executions = 0;
  const registry = createRegistry([command(async () => { executions++; }, true)]);
  await dispatch(fixture().interaction, registry, guildId, logger);
  assert.equal(executions, 0);
  await dispatch(fixture({ permissions: PermissionFlagsBits.Administrator }).interaction, registry, guildId, logger);
  assert.equal(executions, 1);
});

test('unknown commands receive a response', async () => {
  const { interaction, calls } = fixture();
  await dispatch(interaction, new Map(), guildId, logger);
  assert.match((calls[0]?.payload as { content: string }).content, /unavailable/);
});

test('command errors are handled before and after acknowledgement without exposing details', async () => {
  const registry = createRegistry([command(async () => { throw new Error('internal secret'); })]);
  for (const [options, method] of [
    [{}, 'reply'], [{ deferred: true }, 'editReply'], [{ replied: true }, 'followUp'],
    [{ deferred: true, replied: true }, 'followUp'],
  ] as const) {
    const { interaction, calls } = fixture(options);
    await dispatch(interaction, registry, guildId, logger);
    assert.equal(calls[0]?.method, method);
    assert.ok(!JSON.stringify(calls).includes('internal secret'));
  }
  await assert.doesNotReject(dispatch(fixture({ replyFails: true }).interaction, registry, guildId, logger));
});
