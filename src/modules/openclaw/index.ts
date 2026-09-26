import { ChannelType, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction, Client, Message, MessageMentionOptions } from 'discord.js';
import type { Logger } from 'pino';
import type { ChannelAccessStore } from '../../core/channel-access.js';
import type { BotModule } from '../../core/module.js';
import type { OpenClawClient } from './api.js';

interface OpenClawConfig { guildId: string; channelIds: readonly string[]; publicChannels?: boolean; access?: ChannelAccessStore }

export const tclawCommandData = new SlashCommandBuilder()
  .setName('tclaw').setDescription('Talk to OpenClaw in this channel')
  .addStringOption(option => option.setName('prompt').setDescription('What would you like to ask?').setRequired(true).setMaxLength(4000));

export const tclawChannelCommandData = new SlashCommandBuilder()
  .setName('tclaw-channel').setDescription('Configure OpenClaw access per channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
for (const [name, description] of [
  ['enable', 'Allow this channel to send addressed messages and reply context to OpenClaw'],
  ['disable', 'Disable OpenClaw in this channel'],
  ['reset', 'Restore configured defaults for this channel'],
  ['status', 'Show whether OpenClaw is enabled in this channel'],
] as const) {
  tclawChannelCommandData.addSubcommand(sub => sub.setName(name).setDescription(description)
    .addChannelOption(option => option.setName('channel').setDescription('Channel (defaults to this channel)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread)));
}

function isAllowedChannel(message: Pick<Message, 'guildId' | 'guild' | 'channelId'> & {
  channel: Message['channel'] | ChatInputCommandInteraction['channel'];
}, config: OpenClawConfig): boolean {
  if (message.guildId !== config.guildId || !message.channel) return false;
  const override = config.access?.get(message.channelId)
    ?? (message.channel.isThread() && message.channel.parentId ? config.access?.get(message.channel.parentId) : undefined);
  if (override !== undefined) return override;
  if (config.channelIds.includes(message.channelId) || (message.channel.isThread() && !!message.channel.parentId && config.channelIds.includes(message.channel.parentId))) return true;
  if (!config.publicChannels || !message.guild || message.channel.type === ChannelType.PrivateThread) return false;
  const channel = message.channel.isThread() ? message.channel.parent : message.channel;
  return !!channel && 'permissionsFor' in channel &&
    (channel.permissionsFor(message.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) ?? false);
}

export function isAllowedMessage(message: Message, config: OpenClawConfig): boolean {
  return !message.author.bot && !message.webhookId && !message.system && isAllowedChannel(message, config);
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
        if (shutdown.signal.aborted || !isAllowedMessage(message, config)) return;
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
    id: 'openclaw', commands: [{
      data: tclawCommandData,
      async execute(interaction) {
        if (!isAllowedChannel(interaction, config)) {
          await interaction.reply({ content: 'OpenClaw is not enabled in this channel. An administrator can use /tclaw-channel enable.', flags: MessageFlags.Ephemeral });
          return;
        }
        const content = interaction.options.getString('prompt', true).trim();
        if (!content) {
          await interaction.reply({ content: 'Please enter a question.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (stopped || !client.user || active.has(interaction.channelId) || active.size >= 4) {
          await interaction.reply({ content: 'I’m busy just now. Please try again shortly.', flags: MessageFlags.Ephemeral });
          return;
        }
        const work = (async () => {
          await interaction.deferReply();
          if (shutdown.signal.aborted) return;
          let sent = false;
          try {
            const response = await agent.reply({
              session: `threesixty:${client.user!.id}:${config.guildId}:${interaction.channelId}`,
              content: JSON.stringify({ authorId: interaction.user.id, message: content.slice(0, 4000) }),
            }, shutdown.signal);
            for (const chunk of replyChunks(response)) {
              if (shutdown.signal.aborted) return;
              if (!isAllowedChannel(interaction, config)) {
                await interaction.editReply({ content: 'OpenClaw was disabled in this channel.', allowedMentions });
                return;
              }
              if (!sent) await interaction.editReply({ content: chunk, allowedMentions });
              else await interaction.followUp({ content: chunk, allowedMentions });
              sent = true;
            }
          } catch {
            logger.warn({ channelId: interaction.channelId }, 'OpenClaw command failed');
            if (!sent && !shutdown.signal.aborted) await interaction.editReply({
              content: 'I couldn’t get an answer just now. Please try again shortly.', allowedMentions,
            });
          }
        })().finally(() => { active.delete(interaction.channelId); });
        active.set(interaction.channelId, work);
        await work;
      },
    }, {
      data: tclawChannelCommandData,
      async execute(interaction) {
        if (interaction.guildId !== config.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({ content: 'Only server administrators can configure OpenClaw channels.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (!config.access) throw new Error('OpenClaw channel settings are unavailable');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const selected = interaction.options.getChannel('channel');
        const channel = await client.channels.fetch(selected?.id ?? interaction.channelId);
        if (!channel || !('guildId' in channel) || channel.guildId !== config.guildId || !channel.isTextBased() || !('permissionsFor' in channel)) {
          await interaction.editReply('Choose an accessible text channel in this server.');
          return;
        }
        const action = interaction.options.getSubcommand();
        if (action === 'enable') {
          const member = await channel.guild.members.fetchMe();
          const sendPermission = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
          if (!channel.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel, sendPermission])) {
            await interaction.editReply('I need View Channel and Send Messages permissions in that channel.');
            return;
          }
          config.access.set(channel.id, true);
        }
        else if (action === 'disable') config.access.set(channel.id, false);
        else if (action === 'reset') config.access.reset(channel.id);
        const enabled = isAllowedChannel({ guildId: config.guildId, guild: interaction.guild, channelId: channel.id, channel }, config);
        const override = config.access.get(channel.id);
        await interaction.editReply({
          content: `OpenClaw is ${enabled ? 'enabled' : 'disabled'} in <#${channel.id}> (${override === undefined ? 'inherited/default setting' : 'channel override'}).`
            + (enabled ? ' Addressed messages and reply context are sent to OpenClaw and its model backend.' : '')
            + (!channel.isThread() ? ' Channel overrides also apply to its threads unless a thread has its own override.' : ''),
          allowedMentions,
        });
      },
    }],
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
