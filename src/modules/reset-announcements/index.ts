import type { Client } from 'discord.js';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { BotModule } from '../../core/module.js';
import { createResetSource, RetryLater } from './api.js';
import type { DeliveryStore } from './store.js';
import { createResetPoller } from './service.js';
import type { DestinationController } from '../../core/destination.js';
import { createDestinationCommand, destinationCommandData } from '../../core/destination-command.js';

export const resetsCommandData = destinationCommandData('resets', 'Configure automatic Codex reset announcements');

export function createResetAnnouncements(client: Client, destination: DestinationController, storeFor: (channelId: string) => DeliveryStore, config: { guildId: string; pollSeconds: number }, logger: Logger): BotModule {
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  let stopped = true;
  const abort = new AbortController();
  const source = createResetSource(fetch, abort.signal);
  const poll = () => destination.deliver(async ({ channelId }) => {
    await createResetPoller(source, storeFor(channelId), {
      async publish(item) {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !('guildId' in channel) || channel.guildId !== config.guildId || !channel.isSendable()) {
          throw new Error('Reset destination must be a sendable channel in the company server');
        }
        abort.signal.throwIfAborted();
        const nonce = createHash('sha256').update(`${channelId}:${item.nonce}`).digest('hex').slice(0, 24);
        await channel.send({ content: item.content, allowedMentions: { parse: [] }, nonce, enforceNonce: true });
        logger.info({ announcement: item.key }, 'Reset announcement delivered');
      },
    }, abort.signal)();
  });
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
    id: 'reset-announcements', intents: [],
    commands: [createDestinationCommand(resetsCommandData, client, config.guildId, destination, `Checks every ${config.pollSeconds / 60} minutes. The next check posts the latest reset for a new destination.`)],
    async start() { stopped = false; run(); },
    async stop() { stopped = true; clearTimeout(timer); abort.abort(); await active; await destination.drain(); },
  };
}
