import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'Must be a Discord ID');
const flag = z.enum(['true', 'false']).transform(value => value === 'true');
const features = z.object({
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
