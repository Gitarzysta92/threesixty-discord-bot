/** Composition root: the only place that wires feature modules and adapters together. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'discord.js';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { BotModule } from './core/module.js';
import { openSummaryDeliveryStore } from './storage/summary-delivery-store.js';
import { openActivityStore } from './storage/activity-store.js';
import { createCollector } from './modules/activity-collector/index.js';
import { createAnalysis } from './modules/activity-analysis/index.js';
import { createResetAnnouncements } from './modules/reset-announcements/index.js';
import { openDeliveryStore } from './modules/reset-announcements/store.js';

export function composeModules(client: Client, config: Config, logger: Logger) {
  const modules: BotModule[] = [];
  const closers: (() => void)[] = [];
  mkdirSync(config.DATA_DIR, { recursive: true });
  try {
    if (config.ACTIVITY_COLLECTOR_ENABLED || config.ACTIVITY_ANALYSIS_ENABLED) {
      const store = openActivityStore(join(config.DATA_DIR, 'activity.sqlite'));
      closers.push(store.close);
      if (config.ACTIVITY_COLLECTOR_ENABLED) modules.push(createCollector(client, store.writer, {
        guildId: config.DISCORD_GUILD_ID, excludedChannelIds: config.ACTIVITY_EXCLUDED_CHANNEL_IDS, retentionDays: config.ACTIVITY_RETENTION_DAYS,
      }, logger.child({ module: 'activity-collector' })));
      if (config.ACTIVITY_ANALYSIS_ENABLED) {
        const channelId = config.ACTIVITY_SUMMARY_CHANNEL_ID;
        const destination = `${config.DISCORD_GUILD_ID}:${channelId}`;
        const deliveries = channelId ? openSummaryDeliveryStore(join(config.DATA_DIR, 'summaries.sqlite'), destination) : undefined;
        if (deliveries) closers.push(deliveries.close);
        modules.push(createAnalysis(store.reader, config.DISCORD_GUILD_ID, config.ACTIVITY_RETENTION_DAYS,
          deliveries && channelId ? {
            store: deliveries.store, destination, logger: logger.child({ module: 'activity-analysis' }),
            publisher: {
              async publish(content, nonce) {
                const channel = await client.channels.fetch(channelId);
                if (!channel || !('guildId' in channel) || channel.guildId !== config.DISCORD_GUILD_ID || !channel.isSendable()) {
                  throw new Error('Summary destination must be a sendable company-server channel');
                }
                await channel.send({ content, nonce, enforceNonce: true, allowedMentions: { parse: [] } });
              },
            },
          } : undefined));
      }
    }
    if (config.RESETS_CHANNEL_ID) {
      const delivery = openDeliveryStore(join(config.DATA_DIR, 'resets.sqlite'), `${config.DISCORD_GUILD_ID}:${config.RESETS_CHANNEL_ID}`);
      closers.push(delivery.close);
      modules.push(createResetAnnouncements(client, delivery.store, {
        guildId: config.DISCORD_GUILD_ID, channelId: config.RESETS_CHANNEL_ID, pollSeconds: config.RESETS_POLL_SECONDS,
      }, logger.child({ module: 'reset-announcements' })));
    }
  } catch (error) {
    for (const close of closers.reverse()) close();
    throw error;
  }
  return { modules, close: () => { for (const close of closers.reverse()) close(); } };
}
