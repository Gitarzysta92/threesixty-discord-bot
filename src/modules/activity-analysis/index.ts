import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { ActivityRefresher } from '../../contracts/activity-refresh.js';
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
  .setName('activity').setDescription('Refresh message history and summarize company-server activity')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption(option => option.setName('days').setDescription('Rolling window in days (default: 7)').setMinValue(1).setMaxValue(90));

export function createAnalysis(reader: ActivityReader, guildId: string, retentionDays: number, weekly?: DynamicWeeklySummary, refresher?: ActivityRefresher): BotModule {
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
        const from = until - Math.min(days, retentionDays) * 86_400_000;
        await interaction.editReply('Checking stored activity and refreshing missing Discord history. This may take a few minutes.');
        let note = 'History refresh is disabled; this report uses stored observations only.';
        if (refresher) {
          try {
            const refresh = await refresher.refresh(from, until);
            note = `History checked: **${refresh.checked}** channels/threads. ` +
              (refresh.incomplete || refresh.discoveryIncomplete
                ? `**Partial coverage:** ${refresh.incomplete} channels/threads could not be fully checked${refresh.discoveryIncomplete ? '; channel/thread discovery was incomplete' : ''}. Check View Channel and Read Message History permissions, then retry. Completed scans are saved.`
                : 'Accessible history is up to date for this reporting window.');
          } catch (error) {
            await interaction.editReply('An activity refresh could not start. Another refresh may be running; try again shortly.');
            return;
          }
        }
        const result = summarize(reader, guildId, from, until);
        await interaction.editReply({ content: formatSummary(result, 'Activity summary', note) });
      },
    }, ...(weekly ? [createDestinationCommand(summaryCommandData, weekly.client, guildId, weekly.destination, 'Weekly summaries post Sundays at 12:00 Europe/Warsaw, starting with the next due Sunday.')] : [])],
    async start() { if (tick) { stopped = false; run(); } },
    async stop() { stopped = true; await refresher?.stop(); clearTimeout(timer); await active; await weekly?.destination.drain(); },
  };
}
