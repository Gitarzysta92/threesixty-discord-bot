import type { ChatInputCommandInteraction, SlashCommandBuilder, SlashCommandOptionsOnlyBuilder, SlashCommandSubcommandsOnlyBuilder } from 'discord.js';
import type { Logger } from 'pino';

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction, context: { logger: Logger }): Promise<void>;
}

export function createRegistry(commands: readonly Command[]): ReadonlyMap<string, Command> {
  const registry = new Map<string, Command>();
  for (const command of commands) {
    const { name } = command.data.toJSON();
    if (registry.has(name)) throw new Error(`Duplicate command: ${name}`);
    registry.set(name, command);
  }
  return registry;
}
