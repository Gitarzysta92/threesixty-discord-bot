import { REST, Routes } from 'discord.js';
import { loadConfig, loadFeatures } from './config.js';
import { createLogger } from './logger.js';
import { commands } from './commands.js';
import { activityCommandData } from './modules/activity-analysis/index.js';

const body = [...commands.values()].map(command => command.data.toJSON());
if (loadFeatures().ACTIVITY_ANALYSIS_ENABLED) body.push(activityCommandData.toJSON());
// Dry run validates command definitions without credentials or a Discord request.
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify(body, null, 2));
} else {
  const config = loadConfig();
  const logger = createLogger(config);
  try {
    await new REST({ version: '10' }).setToken(config.DISCORD_TOKEN).put(
      Routes.applicationGuildCommands(config.DISCORD_APPLICATION_ID, config.DISCORD_GUILD_ID),
      { body },
    );
    logger.info({ count: body.length, guildId: config.DISCORD_GUILD_ID }, 'Guild commands registered');
  } catch (err) {
    logger.error({ err }, 'Command registration failed');
    process.exitCode = 1;
  }
}
