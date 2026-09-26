import { Events, GatewayIntentBits } from 'discord.js';
import type { Client, Message } from 'discord.js';
import type { Logger } from 'pino';
import type { ActivityWriter, MessageActivity } from '../../contracts/activity.js';
import type { BotModule } from '../../core/module.js';

export interface CollectorConfig { guildId: string; excludedChannelIds: readonly string[]; retentionDays: number }

export function toActivity(message: Pick<Message, 'id' | 'guildId' | 'channelId' | 'author' | 'webhookId' | 'system' | 'createdTimestamp' | 'channel'>, config: CollectorConfig): MessageActivity | null {
  if (message.guildId !== config.guildId || message.author.bot || message.webhookId || message.system) return null;
  if (config.excludedChannelIds.includes(message.channelId) || ('parentId' in message.channel && message.channel.parentId && config.excludedChannelIds.includes(message.channel.parentId))) return null;
  return { messageId: message.id, guildId: message.guildId, channelId: message.channelId, userId: message.author.id, occurredAt: message.createdTimestamp };
}

export function createCollector(client: Client, writer: ActivityWriter, config: CollectorConfig, logger: Logger): BotModule {
  let timer: NodeJS.Timeout | undefined;
  const prune = () => writer.prune(Date.now() - config.retentionDays * 86_400_000);
  const onMessage = (message: Message) => {
    try {
      const event = toActivity(message, config);
      if (event) writer.record(event);
    } catch (err) { logger.error({ err }, 'Activity collection failed'); }
  };
  return {
    id: 'activity-collector', intents: [GatewayIntentBits.GuildMessages], commands: [],
    async start() {
      prune();
      client.on(Events.MessageCreate, onMessage);
      timer = setInterval(() => { try { prune(); } catch (err) { logger.error({ err }, 'Activity retention cleanup failed'); } }, 3_600_000);
    },
    async stop() { client.off(Events.MessageCreate, onMessage); clearInterval(timer); },
  };
}
