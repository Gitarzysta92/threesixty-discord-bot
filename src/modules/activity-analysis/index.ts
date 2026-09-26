import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { ActivityReader } from '../../contracts/activity.js';
import type { BotModule } from '../../core/module.js';
import { summarize } from './service.js';
import { formatSummary } from './format.js';
import { createWeeklyTick } from './schedule.js';
import type { WeeklySummaryDependencies } from './schedule.js';
import type { Logger } from 'pino';

export const activityCommandData = new SlashCommandBuilder()
  .setName('activity').setDescription('Summarize collected company-server activity')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption(option => option.setName('days').setDescription('Rolling window in days (default: 7)').setMinValue(1).setMaxValue(90));

export function createAnalysis(reader: ActivityReader, guildId: string, retentionDays: number, weekly?: WeeklySummaryDependencies & { logger: Logger }): BotModule {
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  let stopped = true;
  const tick = weekly ? createWeeklyTick(reader, guildId, retentionDays, weekly) : undefined;
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
    }],
    async start() { if (tick) { stopped = false; run(); } },
    async stop() { stopped = true; clearTimeout(timer); await active; },
  };
}
