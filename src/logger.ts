import { pino } from 'pino';
import type { Config } from './config.js';

export function createLogger(config: Config) {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'threesixty-discord-bot' },
    // Scrub the configured token even if an upstream error embeds it in text.
    hooks: {
      streamWrite: text => text.replaceAll(config.DISCORD_TOKEN, '[REDACTED]'),
    },
  });
}
