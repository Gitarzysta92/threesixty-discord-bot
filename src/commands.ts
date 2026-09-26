import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { createRegistry } from './core/command.js';
import type { Command } from './core/command.js';
import { systemCommands } from './modules/system/commands.js';
import { canExecute } from './core/permissions.js';

export function createCommands(extra: readonly Command[] = []) {
  const help: Command = {
    data: new SlashCommandBuilder().setName('help').setDescription('List available bot commands'),
    async execute(interaction) {
      const lines = [...commands.values()].filter(command => {
        const permissions = command.data.toJSON().default_member_permissions;
        return canExecute(permissions, interaction.memberPermissions);
      }).map(command => `/${command.data.name} — ${command.data.description}`);
      await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    },
  };

  // The composition root supplies enabled module commands.
  const commands = createRegistry([...systemCommands, ...extra, help]);
  return commands;
}
export const commands = createCommands();
