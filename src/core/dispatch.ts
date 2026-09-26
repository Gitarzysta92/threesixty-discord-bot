import { MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Logger } from 'pino';
import type { Command } from './command.js';
import { canExecute } from './permissions.js';

export async function dispatch(
  interaction: ChatInputCommandInteraction,
  commands: ReadonlyMap<string, Command>,
  guildId: string,
  logger: Logger,
): Promise<void> {
  const log = logger.child({ interactionId: interaction.id, command: interaction.commandName });
  try {
    if (interaction.guildId !== guildId) {
      await interaction.reply({ content: 'This bot is only available in the company server.', flags: MessageFlags.Ephemeral });
      return;
    }
    const command = commands.get(interaction.commandName);
    if (!command) {
      await interaction.reply({ content: 'This command is unavailable. Please contact a bot administrator.', flags: MessageFlags.Ephemeral });
      return;
    }
    // Enforce required permissions at runtime as well as in registration metadata.
    const required = command.data.toJSON().default_member_permissions;
    if (!canExecute(required, interaction.memberPermissions)) {
      await interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
      return;
    }
    await command.execute(interaction, { logger: log });
    log.info('Command completed');
  } catch (err) {
    log.error({ err }, 'Command failed');
    try {
      const content = 'Something went wrong. Please try again or contact a bot administrator.';
      if (interaction.deferred && !interaction.replied) await interaction.editReply({ content });
      else if (interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch (replyError) {
      log.warn({ err: replyError }, 'Could not deliver command error response');
    }
  }
}
