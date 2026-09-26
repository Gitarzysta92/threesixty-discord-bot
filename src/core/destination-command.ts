import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Client } from 'discord.js';
import type { Command } from './command.js';
import type { DestinationController } from './destination.js';

export function destinationCommandData(name: string, description: string) {
  return new SlashCommandBuilder().setName(name).setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('enable').setDescription('Enable or move posts to a channel')
      .addChannelOption(option => option.setName('channel').setDescription('Destination (default: this channel)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand(sub => sub.setName('disable').setDescription('Disable automatic posts'))
    .addSubcommand(sub => sub.setName('status').setDescription('Show the current destination'));
}

export function createDestinationCommand(data: ReturnType<typeof destinationCommandData>, client: Client, guildId: string, controller: DestinationController, timing: string): Command {
  return {
    data,
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (interaction.guildId !== guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.editReply('Only company-server administrators can configure this feature.');
        return;
      }
      const action = interaction.options.getSubcommand();
      if (action === 'status') {
        const destination = controller.read();
        await interaction.editReply(destination ? `Enabled in <#${destination.channelId}>. ${timing}` : 'Automatic posts are disabled.');
        return;
      }
      if (action === 'disable') {
        await controller.configure(null);
        await interaction.editReply('Automatic posts are disabled.');
        return;
      }
      const channelId = interaction.options.getChannel('channel')?.id ?? interaction.channelId;
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('guildId' in channel) || channel.guildId !== guildId ||
          (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        await interaction.editReply('Choose a text or announcement channel in this server.');
        return;
      }
      const member = await channel.guild.members.fetchMe();
      if (!channel.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        await interaction.editReply('I need View Channel and Send Messages permissions in that channel.');
        return;
      }
      await controller.configure(channel.id);
      await interaction.editReply(`Enabled in <#${channel.id}>. ${timing}`);
    },
  };
}
