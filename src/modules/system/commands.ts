import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/command.js';

export const systemCommands: Command[] = [
  {
    data: new SlashCommandBuilder().setName('ping').setDescription('Check whether the bot is responding'),
    async execute(interaction) {
      const ping = interaction.client.ws.ping;
      await interaction.reply({ content: `Pong! Gateway latency: ${ping < 0 ? 'measuring…' : `${ping} ms`}`, flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder().setName('status').setDescription('Show bot health (administrators only)').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
      await interaction.reply({
        content: `Bot is online.\nUptime: ${Math.floor(process.uptime())} seconds\nGateway: ${interaction.client.isReady() ? 'ready' : 'connecting'}`,
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];
