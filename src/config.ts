import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'Must be a Discord ID');
const flag = z.enum(['true', 'false']).transform(value => value === 'true');
const features = z.object({
  OPENCLAW_ENABLED: flag.default(false),
  DATA_DIR: z.string().min(1).default('./data'),
  RESETS_POLL_SECONDS: z.coerce.number().int().min(60).max(86400).default(300),
  ACTIVITY_COLLECTOR_ENABLED: flag.default(true),
  ACTIVITY_ANALYSIS_ENABLED: flag.default(true),
  ACTIVITY_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  ACTIVITY_EXCLUDED_CHANNEL_IDS: z.string().default('').transform(value => value.split(',').map(id => id.trim()).filter(Boolean)).pipe(z.array(snowflake)),
});
export function loadFeatures(env: NodeJS.ProcessEnv = process.env) {
  return features.parse(env);
}
const schema = features.extend({
  DISCORD_TOKEN: z.string().trim().min(1, 'Bot token is required'),
  DISCORD_APPLICATION_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  OPENCLAW_NATIVE_DISCORD: flag.default(false),
  OPENCLAW_GATEWAY_URL: z.string().url().default('ws://threesixty-openclaw:18789').refine(value => { const url = new URL(value); return ['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password; }, 'Must be a ws/wss Gateway URL without credentials'),
  OPENCLAW_PRIVATE_NETWORK: flag.default(false),
  OPENCLAW_PUBLIC_CHANNELS: flag.default(false),
  OPENCLAW_BASE_URL: z.string().default('http://127.0.0.1:18789/v1').refine(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
    catch { return false; }
  }, 'Must be an HTTP(S) base URL without credentials, query or fragment'),
  OPENCLAW_TOKEN: z.string().trim().default(''),
  OPENCLAW_AGENT_ID: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('discord'),
  OPENCLAW_CHANNEL_IDS: z.string().default('').transform(value => value.split(',').map(id => id.trim()).filter(Boolean)).pipe(z.array(snowflake)),
  OPENCLAW_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(120).default(60),
}).superRefine((config, context) => {
  if (!config.OPENCLAW_ENABLED) return;
  if (!config.OPENCLAW_TOKEN) context.addIssue({ code: 'custom', path: ['OPENCLAW_TOKEN'], message: 'Required when OpenClaw is enabled' });
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Only report field names and validation messages, never supplied values.
    throw new Error(`Invalid configuration: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return result.data;
}
