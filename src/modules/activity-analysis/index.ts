import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { ActivityReader } from '../../contracts/activity.js';
import type { BotModule } from '../../core/module.js';
import { summarize } from './service.js';
import { formatSummary } from './format.js';
import { createWeeklyTick } from './schedule.js';
import type { WeeklySummaryDependencies } from './schedule.js';
import type { Logger } from 'pino';
import type { Client } from 'discord.js';
import type { DestinationController } from '../../core/destination.js';
import { createDestinationCommand, destinationCommandData } from '../../core/destination-command.js';

export const summaryCommandData = destinationCommandData('activity-summary', 'Configure weekly activity summaries');
export interface DynamicWeeklySummary {
  client: Client;
  destination: DestinationController;
  dependenciesFor(channelId: string, enabledAt: number): WeeklySummaryDependencies;
  logger: Logger;
}

export const activityCommandData = new SlashCommandBuilder()
  .setName('activity').setDescription('Summarize collected company-server activity')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption(option => option.setName('days').setDescription('Rolling window in days (default: 7)').setMinValue(1).setMaxValue(90));

export function createAnalysis(reader: ActivityReader, guildId: string, retentionDays: number, weekly?: DynamicWeeklySummary): BotModule {
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  let stopped = true;
  const tick = weekly ? () => weekly.destination.deliver(async ({ channelId, enabledAt }) => {
    const dependencies = weekly.dependenciesFor(channelId, enabledAt);
    await createWeeklyTick(reader, guildId, retentionDays, { ...dependencies, store: {
      ...dependencies.store, enabledAt: () => Math.max(enabledAt, dependencies.store.enabledAt()),
    } })();
  }) : undefined;
  const run = () => {
    active = (async () => {
      try { await tick?.(); }
      catch (err) { weekly?.logger.error({ err }, 'Weekly summary failed; will retry'); }
      if (!stopped) timer = setTimeout(run, 60_000);
    })();
  };
  return {
    id: 'activity-analysis', intents: [],
    commands: [{
      data: activityCommandData,
      async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const days = interaction.options.getInteger('days') ?? 7;
        const until = Date.now();
        const from = Math.max(until - Math.min(days, retentionDays) * 86_400_000, reader.collectionStartedAt());
        const result = summarize(reader, guildId, Math.min(from, until - 1), until);
        await interaction.editReply({ content: formatSummary(result) });
      },
    }, ...(weekly ? [createDestinationCommand(summaryCommandData, weekly.client, guildId, weekly.destination, 'Weekly summaries post Sundays at 12:00 Europe/Warsaw, starting with the next due Sunday.')] : [])],
    async start() { if (tick) { stopped = false; run(); } },
    async stop() { stopped = true; clearTimeout(timer); await active; await weekly?.destination.drain(); },
  };
}
