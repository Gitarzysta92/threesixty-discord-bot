import { Client, Events, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createCommands } from './commands.js';
import { dispatch } from './core/dispatch.js';
import { composeModules } from './app.js';
import { ModuleHost, applyModuleIntents } from './core/module.js';

const config = loadConfig();
const logger = createLogger(config);
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: { parse: [], repliedUser: false },
});
const application = composeModules(client, config, logger);
const host = new ModuleHost(application.modules);
applyModuleIntents(client, application.modules);
const commands = createCommands(application.modules.flatMap(module => [...module.commands]));
let starting: Promise<void> = Promise.resolve();

client.once(Events.ClientReady, ready => {
  if (!ready.guilds.cache.has(config.DISCORD_GUILD_ID)) {
    logger.error('Bot is not installed in the configured company server');
    void shutdown(1);
    return;
  }
  starting = host.start();
  void starting.then(() => {
    logger.info({ botId: ready.user.id, guildId: config.DISCORD_GUILD_ID, modules: application.modules.map(module => module.id) }, 'Bot ready');
  }).catch(err => {
    logger.fatal({ err }, 'Module startup failed');
    void shutdown(1);
  });
});
client.on(Events.InteractionCreate, interaction => {
  if (interaction.isChatInputCommand()) {
    void dispatch(interaction, commands, config.DISCORD_GUILD_ID, logger);
  }
});
client.on(Events.Error, err => logger.error({ err }, 'Discord client error'));
client.on(Events.Warn, message => logger.warn({ message }, 'Discord warning'));

let stopping = false;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  logger.info('Shutting down');
  const deadline = setTimeout(() => process.exit(code || 1), 10_000);
  deadline.unref();
  try {
    await starting.catch(() => {});
    await host.stop();
  } catch (err) {
    logger.error({ err }, 'Module shutdown failed');
    process.exitCode = 1;
  } finally {
    await client.destroy();
    application.close();
  }
}
process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });

try {
  await client.login(config.DISCORD_TOKEN);
} catch (err) {
  logger.fatal({ err }, 'Bot startup failed');
  await shutdown(1);
}
