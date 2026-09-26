import { ChannelType, PermissionFlagsBits, Routes } from 'discord.js';
import type { APIMessage, APIThreadChannel, Client } from 'discord.js';
import type { HistorySource } from './history.js';
import type { CollectorConfig } from './index.js';

export function discordHistorySource(client: Client, config: CollectorConfig): HistorySource {
  const excluded = new Set(config.excludedChannelIds);
  return {
    async channels(signal) {
      const guild = await client.guilds.fetch(config.guildId);
      const member = await guild.members.fetchMe();
      const channels = await guild.channels.fetch();
      const ids = new Set<string>();
      let incomplete = false;
      let skipped = 0;
      const parents = [...channels.values()].filter(channel => channel && !excluded.has(channel.id) && !excluded.has(channel.parentId ?? ''));
      const readable = new Set<string>();
      for (const channel of parents) {
        if (!channel || channel.type === ChannelType.GuildCategory) continue;
        if (!channel.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) { skipped++; continue; }
        readable.add(channel.id);
        if (channel.isTextBased()) ids.add(channel.id);
      }
      const addThread = (thread: APIThreadChannel) => {
        if (thread.parent_id && readable.has(thread.parent_id) && !excluded.has(thread.id)) ids.add(thread.id);
      };
      try {
        const active = await client.rest.get(Routes.guildActiveThreads(config.guildId), { signal }) as { threads: APIThreadChannel[] };
        active.threads.forEach(addThread);
      } catch { incomplete = true; }
      for (const channel of parents) {
        if (!channel || !readable.has(channel.id) || ![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type)) continue;
        const routes: { path: `/${string}`; joined: boolean }[] = [{ path: `/channels/${channel.id}/threads/archived/public`, joined: false }];
        if (channel.type === ChannelType.GuildText) {
          routes.push(channel.permissionsFor(member).has(PermissionFlagsBits.ManageThreads)
            ? { path: `/channels/${channel.id}/threads/archived/private`, joined: false }
            : { path: `/channels/${channel.id}/users/@me/threads/archived/private`, joined: true });
        }
        for (const route of routes) {
          let before: string | undefined;
          try {
            for (;;) {
              signal.throwIfAborted();
              const query = new URLSearchParams({ limit: '100', ...(before ? { before } : {}) });
              const page = await client.rest.get(route.path, { query, signal }) as { threads: APIThreadChannel[]; has_more: boolean };
              page.threads.forEach(addThread);
              if (!page.has_more) break;
              const last = page.threads.at(-1);
              const next = route.joined ? last?.id : last?.thread_metadata?.archive_timestamp;
              if (!next || next === before) throw new Error('Thread pagination did not advance');
              before = next;
            }
          } catch { incomplete = true; }
        }
      }
      return { ids: [...ids], incomplete, skipped };
    },
    async messages(channelId, before, signal) {
      const page = await client.rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: '100', before }), signal }) as APIMessage[];
      return page.map(message => {
        const timestamp = Date.parse(message.timestamp);
        // Match the live collector: user messages, replies, and thread-starter messages.
        const human = !message.author.bot && !message.webhook_id && [0, 19, 21].includes(message.type);
        return { id: message.id, timestamp, activity: human ? {
          messageId: message.id, guildId: config.guildId, channelId, userId: message.author.id, occurredAt: timestamp,
        } : null };
      });
    },
  };
}
