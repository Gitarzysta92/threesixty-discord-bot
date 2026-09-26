/** Composition root: the only place that wires feature modules and adapters together. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'discord.js';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { BotModule } from './core/module.js';
import { DestinationController } from './core/destination.js';
import { openChannelAccessStore } from './storage/channel-access-store.js';
import { openDestinationStore } from './storage/destination-store.js';
import { openSummaryDeliveryStore } from './storage/summary-delivery-store.js';
import { openActivityStore } from './storage/activity-store.js';
import { createHistoryRefresher } from './modules/activity-collector/history.js';
import { discordHistorySource } from './modules/activity-collector/discord-history.js';
import { createCollector } from './modules/activity-collector/index.js';
import { createAnalysis } from './modules/activity-analysis/index.js';
import { createResetAnnouncements } from './modules/reset-announcements/index.js';
import { openDeliveryStore } from './modules/reset-announcements/store.js';
import { createOpenClaw } from './modules/openclaw/index.js';
import { createOpenClawClient } from './modules/openclaw/api.js';

export function composeModules(client: Client, config: Config, logger: Logger) {
  const modules: BotModule[] = [];
  const closers: (() => void)[] = [];
  mkdirSync(config.DATA_DIR, { recursive: true });
  try {
    if (config.OPENCLAW_ENABLED) {
      const access = openChannelAccessStore(join(config.DATA_DIR, 'openclaw-settings.sqlite'), config.DISCORD_GUILD_ID);
      closers.push(access.close);
      modules.push(createOpenClaw(client, createOpenClawClient({
      baseUrl: config.OPENCLAW_BASE_URL, token: config.OPENCLAW_TOKEN,
      agentId: config.OPENCLAW_AGENT_ID, timeoutMs: config.OPENCLAW_TIMEOUT_SECONDS * 1000,
    }), { guildId: config.DISCORD_GUILD_ID, channelIds: config.OPENCLAW_CHANNEL_IDS, publicChannels: config.OPENCLAW_PUBLIC_CHANNELS, access: access.store }, logger.child({ module: 'openclaw' })));
    }
    const settings = openDestinationStore(join(config.DATA_DIR, 'settings.sqlite'));
    closers.push(settings.close);
    if (config.ACTIVITY_COLLECTOR_ENABLED || config.ACTIVITY_ANALYSIS_ENABLED) {
      const store = openActivityStore(join(config.DATA_DIR, 'activity.sqlite'));
      closers.push(store.close);
      if (config.ACTIVITY_COLLECTOR_ENABLED) modules.push(createCollector(client, store.writer, {
        guildId: config.DISCORD_GUILD_ID, excludedChannelIds: config.ACTIVITY_EXCLUDED_CHANNEL_IDS, retentionDays: config.ACTIVITY_RETENTION_DAYS,
      }, logger.child({ module: 'activity-collector' })));
      if (config.ACTIVITY_ANALYSIS_ENABLED) {
        const deliveries = new Map<string, ReturnType<typeof openSummaryDeliveryStore>>();
        modules.push(createAnalysis(store.reader, config.DISCORD_GUILD_ID, config.ACTIVITY_RETENTION_DAYS, {
          client,
          destination: new DestinationController(settings.forModule(config.DISCORD_GUILD_ID, 'activity-summary')),
          logger: logger.child({ module: 'activity-analysis' }),
          dependenciesFor(channelId, enabledAt) {
            const destination = `${config.DISCORD_GUILD_ID}:${channelId}`;
            let delivery = deliveries.get(channelId);
            if (!delivery) {
              delivery = openSummaryDeliveryStore(join(config.DATA_DIR, 'summaries.sqlite'), destination, enabledAt);
              deliveries.set(channelId, delivery);
              closers.push(delivery.close);
            }
            return {
              store: delivery.store, destination,
              publisher: {
                async publish(content, nonce) {
                  const channel = await client.channels.fetch(channelId);
                  if (!channel || !('guildId' in channel) || channel.guildId !== config.DISCORD_GUILD_ID || !channel.isSendable()) {
                    throw new Error('Summary destination must be a sendable company-server channel');
                  }
                  await channel.send({ content, nonce, enforceNonce: true, allowedMentions: { parse: [] } });
                },
              },
            };
          },
        }, config.ACTIVITY_COLLECTOR_ENABLED ? createHistoryRefresher(
          discordHistorySource(client, { guildId: config.DISCORD_GUILD_ID, excludedChannelIds: config.ACTIVITY_EXCLUDED_CHANNEL_IDS, retentionDays: config.ACTIVITY_RETENTION_DAYS }),
          store.writer, store.coverage, config.DISCORD_GUILD_ID,
        ) : undefined));
      }
    }
    const resetDeliveries = new Map<string, ReturnType<typeof openDeliveryStore>>();
    modules.push(createResetAnnouncements(client,
      new DestinationController(settings.forModule(config.DISCORD_GUILD_ID, 'resets')),
      channelId => {
        let delivery = resetDeliveries.get(channelId);
        if (!delivery) {
          delivery = openDeliveryStore(join(config.DATA_DIR, 'resets.sqlite'), `${config.DISCORD_GUILD_ID}:${channelId}`);
          resetDeliveries.set(channelId, delivery);
          closers.push(delivery.close);
        }
        return delivery.store;
      },
      { guildId: config.DISCORD_GUILD_ID, pollSeconds: config.RESETS_POLL_SECONDS },
      logger.child({ module: 'reset-announcements' }),
    ));
  } catch (error) {
    for (const close of closers.reverse()) close();
    throw error;
  }
  return { modules, close: () => { for (const close of closers.reverse()) close(); } };
}
