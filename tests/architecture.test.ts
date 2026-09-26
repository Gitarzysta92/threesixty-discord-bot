import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModuleHost, applyModuleIntents } from '../src/core/module.js';
import { Client, GatewayIntentBits } from 'discord.js';
import type { BotModule } from '../src/core/module.js';

test('module intents reach Discord client options even when its bitfield is frozen', async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  applyModuleIntents(client, [{ id: 'collector', intents: [GatewayIntentBits.GuildMessages], commands: [], async start() {}, async stop() {} }]);
  assert.equal(client.options.intents.has(GatewayIntentBits.Guilds), true);
  assert.equal(client.options.intents.has(GatewayIntentBits.GuildMessages), true);
  assert.equal(client.options.intents.has(GatewayIntentBits.MessageContent), false);
  await client.destroy();
});

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]);
}

test('feature modules do not import sibling implementations or composition root', () => {
  for (const name of ['reset-announcements', 'activity-collector', 'activity-analysis', 'openclaw']) {
    for (const path of files(`src/modules/${name}`).filter(path => path.endsWith('.ts'))) {
      const imports = [...readFileSync(path, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]!);
      for (const imported of imports) {
        assert.ok(!/^\.\.\/(?!\.\.\/)/.test(imported), `${path} imports a sibling module: ${imported}`);
        assert.ok(!/\/app\.js$|\/commands\.js$|\/storage\//.test(imported), `${path} imports application wiring/storage`);
      }
    }
  }
});

test('host unwinds startup and shuts down in reverse order', async () => {
  const events: string[] = [];
  const module = (id: string, fail = false): BotModule => ({
    id, intents: [], commands: [],
    async start() { events.push(`start:${id}`); if (fail) throw new Error('startup failed'); },
    async stop() { events.push(`stop:${id}`); },
  });
  const host = new ModuleHost([module('a'), module('b'), module('c', true)]);
  await assert.rejects(host.start(), /startup failed/);
  assert.deepEqual(events, ['start:a', 'start:b', 'start:c', 'stop:b', 'stop:a']);
  await host.stop();
  assert.equal(events.length, 5);
  assert.throws(() => new ModuleHost([module('a'), module('a')]), /Duplicate/);
});
