import type { Client } from 'discord.js';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { BotModule } from '../../core/module.js';
import { createResetSource, RetryLater } from './api.js';
import type { DeliveryStore } from './store.js';
import { createResetPoller } from './service.js';

export function createResetAnnouncements(client: Client, store: DeliveryStore, config: { guildId: string; channelId: string; pollSeconds: number }, logger: Logger): BotModule {
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  let stopped = true;
  const abort = new AbortController();
  const poll = createResetPoller(createResetSource(fetch, abort.signal), store, {
    async publish(item) {
      const channel = await client.channels.fetch(config.channelId);
      if (!channel || !('guildId' in channel) || channel.guildId !== config.guildId || !channel.isSendable()) {
        throw new Error('Reset destination must be a sendable channel in the company server');
      }
      abort.signal.throwIfAborted();
      const nonce = createHash('sha256').update(`${config.channelId}:${item.nonce}`).digest('hex').slice(0, 24);
      await channel.send({ content: item.content, allowedMentions: { parse: [] }, nonce, enforceNonce: true });
      logger.info({ announcement: item.key }, 'Reset announcement delivered');
    },
  }, abort.signal);
  const run = () => {
    active = (async () => {
      let delay = config.pollSeconds * 1000;
      try { await poll(); }
      catch (err) {
        if (!stopped) logger.error({ err }, 'Reset poll failed; will retry');
        if (err instanceof RetryLater) delay = Math.max(delay, err.delayMs);
      }
      if (!stopped) timer = setTimeout(run, Math.min(delay, 2_147_483_647));
    })();
  };
  return {
    id: 'reset-announcements', intents: [], commands: [],
    async start() { stopped = false; run(); },
    async stop() { stopped = true; clearTimeout(timer); abort.abort(); await active; },
  };
}
