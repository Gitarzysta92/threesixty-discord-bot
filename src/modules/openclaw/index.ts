import { Events, GatewayIntentBits } from 'discord.js';
import type { Client, Message, MessageMentionOptions } from 'discord.js';
import type { Logger } from 'pino';
import type { BotModule } from '../../core/module.js';
import type { OpenClawClient } from './api.js';

interface OpenClawConfig { guildId: string; channelIds: readonly string[] }

export function isAllowedMessage(message: Message, config: OpenClawConfig): boolean {
  return message.guildId === config.guildId && !message.author.bot && !message.webhookId && !message.system &&
    (config.channelIds.includes(message.channelId) || (message.channel.isThread() && !!message.channel.parentId && config.channelIds.includes(message.channel.parentId)));
}

/** Discord messages use UTF-16 length limits; preserve surrogate pairs at boundaries. */
export function replyChunks(text: string): string[] {
  const capped = text.length > 7900 ? `${text.slice(0, 7900).replace(/[\uD800-\uDBFF]$/, '')}\n[Response shortened]` : text;
  const chunks: string[] = [];
  let remaining = capped;
  while (remaining.length) {
    let end = Math.min(2000, remaining.length);
    if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1]!)) end--;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return chunks;
}

export function createOpenClaw(client: Client, agent: OpenClawClient, config: OpenClawConfig, logger: Logger): BotModule {
  const active = new Map<string, Promise<void>>();
  let shutdown = new AbortController();
  let stopped = true;
  const allowedMentions: MessageMentionOptions = { parse: [], repliedUser: false };

  async function respond(message: Message) {
    const botId = client.user?.id;
    if (!botId) return;
    const mentioned = new RegExp(`<@!?${botId}>`).test(message.content);
    let referenced: Message | undefined;
    if (message.reference?.messageId && message.reference.channelId === message.channelId) {
      // Fetch only same-channel references; never pull context from another room.
      try { referenced = await message.fetchReference(); } catch { /* Deleted or inaccessible reference. */ }
    }
    if (!mentioned && referenced?.author.id !== botId) return;
    if (shutdown.signal.aborted) return;
    const content = message.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
    if (!content) {
      await message.reply({ content: 'Ask me a question in your message; I currently support text only.', allowedMentions });
      return;
    }
    const prompt = JSON.stringify({
      authorId: message.author.id,
      message: content.slice(0, 4000),
      ...(referenced ? { replyTo: { authorId: referenced.author.id, message: referenced.content.slice(0, 2000) } } : {}),
    });
    let sent = false;
    try {
      if ('sendTyping' in message.channel) await message.channel.sendTyping().catch(() => {});
      const response = await agent.reply({ session: `threesixty:${client.user!.id}:${config.guildId}:${message.channelId}`, content: prompt }, shutdown.signal);
      for (const chunk of replyChunks(response)) {
        if (shutdown.signal.aborted) return;
        await message.reply({ content: chunk, allowedMentions });
        sent = true;
      }
    } catch {
      logger.warn({ channelId: message.channelId }, 'OpenClaw conversation failed');
      if (!sent && !shutdown.signal.aborted) await message.reply({ content: 'I couldn’t get an answer just now. Please try again shortly.', allowedMentions }).catch(() => {});
    }
  }

  const onMessage = (message: Message) => {
    if (stopped || !isAllowedMessage(message, config)) return;
    // Bound concurrency and avoid overlapping runs in one conversation. No unbounded queue.
    if (active.has(message.channelId) || active.size >= 4) return;
    const work = respond(message).catch(() => {
      logger.warn({ channelId: message.channelId }, 'OpenClaw message handling failed');
    }).finally(() => { active.delete(message.channelId); });
    active.set(message.channelId, work);
  };
  return {
    id: 'openclaw', commands: [],
    intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    async start() { if (!stopped) return; shutdown = new AbortController(); stopped = false; client.on(Events.MessageCreate, onMessage); },
    async stop() {
      stopped = true;
      client.off(Events.MessageCreate, onMessage);
      shutdown.abort();
      await Promise.allSettled(active.values());
    },
  };
}
