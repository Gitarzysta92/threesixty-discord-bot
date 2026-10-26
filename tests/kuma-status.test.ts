import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pluginUrl = new URL('../deployment/openclaw/kuma-status/index.mjs', import.meta.url).href;
const { parseMetrics, fetchStatus, createTool } = await import(pluginUrl);

const metrics = `monitor_status{monitor_id="1",monitor_name="Website",monitor_url="https://private.example/secret"} 1
monitor_uptime_ratio{monitor_id="1",monitor_name="Website",window="1d"} 0.995
monitor_response_time_seconds{monitor_id="1",monitor_name="Website",window="1d"} 0.123
monitor_status{monitor_id="2",monitor_name="API @everyone"} 0
monitor_uptime_ratio{monitor_id="2",monitor_name="API @everyone",window="1d"} 0.9
`;
const env = { KUMA_METRICS_API_KEY: 'kuma-test-key', KUMA_CF_ACCESS_CLIENT_ID: 'cf-test-id', KUMA_CF_ACCESS_CLIENT_SECRET: 'cf-test-secret' };

test('metrics expose bounded status data without raw monitor URLs or Discord pings', () => {
  const parsed = parseMetrics(metrics);
  assert.deepEqual(parsed, [
    { name: 'Website', status: 'up', uptime24hPercent: 99.5, responseMs: 123 },
    { name: 'API @\u200beveryone', status: 'down', uptime24hPercent: 90, responseMs: null },
  ]);
  assert.doesNotMatch(JSON.stringify(parsed), /private\.example|secret/);
  assert.throws(() => parseMetrics('<html>Cloudflare login</html>'));
  assert.throws(() => parseMetrics('monitor_status{monitor_id="1",monitor_name="Bad"} 4'));
  assert.throws(() => parseMetrics(metrics + 'monitor_status{monitor_id="1",monitor_name="Website"} 1'));
});

test('fetch uses only fixed HTTPS metrics with credentials in headers and rejects login responses', async () => {
  let url: string | undefined;
  let options: RequestInit | undefined;
  const request = async (input: string, init: RequestInit) => {
    url = input;
    options = init;
    return new Response(metrics, { headers: { 'Content-Type': 'text/plain' } });
  };
  const data = await fetchStatus(env, request);
  assert.equal(url, 'https://kuma.threesixty.dev/metrics');
  assert.equal(options?.redirect, 'manual');
  assert.equal((options?.headers as Record<string, string>).Authorization,
    'Basic ' + Buffer.from(':kuma-test-key').toString('base64'));
  assert.equal((options?.headers as Record<string, string>)['CF-Access-Client-Secret'], 'cf-test-secret');
  assert.deepEqual(data.counts, { down: 1, up: 1, pending: 0, maintenance: 0 });
  assert.doesNotMatch(JSON.stringify(data), /kuma-test-key|cf-test-secret|private\.example/);
  await assert.rejects(fetchStatus(env, async () => new Response('', { status: 302 })));
  await assert.rejects(fetchStatus(env, async () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })));
  await assert.rejects(fetchStatus({ ...env, KUMA_METRICS_API_KEY: '' }, request));
});

test('tool is exposed only in currently enabled Discord channels and fails closed', async () => {
  const config = { channels: { discord: { guilds: { guild: { channels: { '123': { enabled: true }, '456': { enabled: false } } } } } } };
  const factory = createTool({ guildId: 'guild' }, () => config, env,
    async () => new Response(metrics, { headers: { 'Content-Type': 'text/plain' } }));
  const context = { agentId: 'discord', sessionKey: 'agent:discord:discord:channel:123' };
  assert.equal(factory({ ...context, sessionKey: 'agent:discord:discord:channel:456' }), null);
  assert.equal(factory({ ...context, sessionKey: 'agent:discord:main' }), null);
  assert.equal(factory({ ...context, agentId: 'main' }), null);
  assert.equal(createTool({ guildId: 'guild' }, () => config, { ...env, KUMA_METRICS_API_KEY: '' })(context), null);
  const tool = factory(context);
  assert.equal(tool.name, 'kuma_status');
  assert.equal(JSON.parse((await tool.execute()).content[0].text).counts.down, 1);
  config.channels.discord.guilds.guild.channels['123'].enabled = false;
  assert.equal((await tool.execute()).isError, true);
});

test('plugin declares startup loading and registers the optional tool', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../deployment/openclaw/kuma-status/openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.activation.onStartup, true);
  assert.deepEqual(manifest.contracts.tools, ['kuma_status']);
  let options: { name: string; optional: boolean } | undefined;
  (await import(pluginUrl)).default.register({ pluginConfig: { guildId: 'guild' },
    runtime: { config: { current: () => ({}) } }, registerTool(_factory: unknown, value: typeof options) { options = value; } });
  assert.deepEqual(options, { name: 'kuma_status', optional: true });
});
