import { ChannelType, escapeMarkdown } from 'discord.js';
import type { Client } from 'discord.js';

/** Resolve current category context without coupling stored activity to Discord names. */
export async function channelCategories(client: Client, guildId: string, ids: string[]): Promise<Record<string, string>> {
  const labels: Record<string, string> = {};
  try {
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    for (const id of ids) {
      try {
        const channel = channels.get(id) ?? await guild.channels.fetch(id);
        if (!channel) { labels[id] = 'Unavailable category'; continue; }
        // Thread parents are channels; their parents are categories.
        const parent = channel.isThread() ? channel.parent : channel;
        const category = parent?.parent;
        labels[id] = category?.type === ChannelType.GuildCategory
          ? escapeMarkdown(category.name.replace(/[\r\n]/g, ' ').slice(0, 48))
          : parent ? 'No category' : 'Unavailable category';
      } catch { labels[id] = 'Unavailable category'; }
    }
  } catch { for (const id of ids) labels[id] = 'Unavailable category'; }
  return labels;
}
