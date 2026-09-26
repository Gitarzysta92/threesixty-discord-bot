# ThreeSixty Discord Bot

Foundation for a multipurpose company Discord bot. TypeScript, discord.js, Node.js 22.13+, and npm. Restricted to one configured company server.

## Setup

1. Install Node.js 22 (`nvm install` if you use nvm), then run `npm ci`.
2. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Copy its application ID and create/reset the bot token under **Bot**.
3. Configure **Guild Install** with `bot` and `applications.commands` scopes. Install the bot into your company server using the generated link. No Administrator permission or privileged intents are needed. Give the bot View Channel access for activity collection, and View Channel plus Send Messages for the reset destination.
4. Enable Discord Developer Mode and copy your server ID.
5. Run `cp .env.example .env` and fill in the token, application ID, and server ID. Keep `.env` private.
6. Run `npm run commands:deploy`, then `npm run dev`.
7. In your server, try `/ping`, `/help`, `/status`, and `/activity days:7` (the last two are administrators only).
8. Set `RESETS_CHANNEL_ID` to an existing text or announcement channel and restart to enable automatic reset posts. The first poll posts the latest known reset and any scheduled reset; it does not flood the channel with history.

Activity collection and analysis are enabled independently by `ACTIVITY_COLLECTOR_ENABLED` and `ACTIVITY_ANALYSIS_ENABLED`. Configure excluded channels and retention in `.env`. Statistics begin when collection starts; message text is never stored. Keep `DATA_DIR` on persistent storage. See [module architecture and task ownership](docs/ARCHITECTURE.md) for boundaries, contracts, and operational details.

Command deployment replaces all guild commands owned by this application in the configured server, including commands removed from code. Use a dedicated Discord application. Registration is an explicit deployment step; it does not run at bot startup. Re-run it when command names, descriptions, options, or permissions change. Commands are guild-scoped, following [Discord's application command API](https://docs.discord.com/developers/interactions/application-commands).

## Development

```sh
npm run dev                         # Watch source changes
npm run commands:deploy -- --dry-run # Inspect command payloads without credentials/network
npm run check                       # Typecheck, tests, production build
npm run build
npm start                           # Run compiled output
```

CI runs the same checks on pushes and pull requests. Dependency versions are captured in `package-lock.json`; use `npm ci` for repeatable installations. No real token or Discord connection is needed for tests.

## Add a feature

Create a folder in `src/modules/` and expose a `BotModule` factory with commands and lifecycle hooks (see `src/core/module.ts`). Each command contains a slash command builder and an async `execute(interaction, { logger })` handler. Wire the module in `src/app.ts`; module commands are passed to `createCommands` for runtime dispatch and help. Add the same exported command definitions to `scripts/deploy-commands.ts` under the feature enablement flag. Duplicate command names fail immediately.

```ts
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/command.js';

export const exampleCommands: Command[] = [{
  data: new SlashCommandBuilder()
    .setName('example')
    .setDescription('Example company workflow'),
  async execute(interaction, { logger }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Call your service here. Defer before work that may exceed 3 seconds.
    await interaction.editReply('Done.');
    logger.info('Example completed');
  },
];
```

Use `setDefaultMemberPermissions(...)` for restricted commands. The dispatcher enforces the same required permissions at runtime, even if a server command override grants visibility. Help filters by these required permissions; Discord's per-role/channel command overrides are managed separately in server settings. Keep sensitive replies ephemeral. Mentions are disabled by default.

Keep external integrations and business logic inside each feature module or a shared service when multiple modules need it. Activity and reset delivery use separate SQLite stores. The reset module integrates with the Codex Resets public API. Modules must not import sibling implementations: exchange data through contracts under `src/contracts/`. Buttons, modals, voice tracking, and multi-server operation need additional handlers/design.

## Operations

Run `npm run build` and `npm start` under a process manager or your hosting platform, injecting the three `DISCORD_*` environment variables and optionally `LOG_LEVEL`. Run one instance for this initial foundation. Standard output contains structured JSON logs; route these through your platform's logging system. The configured bot token is scrubbed from log output. Do not log interaction payloads, messages, or integration secrets.

The client uses `Guilds` and, when activity collection is enabled, `GuildMessages` (no Message Content intent), rejects commands outside the configured server, handles failed interactions centrally, and disconnects on SIGINT/SIGTERM. Startup fails if configuration is invalid or the bot is absent from the configured server. `/status` reports gateway readiness and process uptime; no HTTP health endpoint is included.

Before production, verify installation, all enabled commands, reset delivery, administrator restrictions, and shutdown in a test server. Local tests mock interactions and do not replace this live check.

## Weekly summaries

Set `ACTIVITY_SUMMARY_CHANNEL_ID` in `.env` to the destination channel and restart the bot. With activity analysis enabled, it posts **every Sunday at 12:00 noon, Europe/Warsaw**, automatically adjusting for daylight saving. Reports cover Sunday noon to Sunday noon. Use a channel whose members should have access to server-wide statistics and grant the bot View Channel and Send Messages.

The scheduler checks once per minute, retries failed sends, and persists delivery receipts in `DATA_DIR/summaries.sqlite`. First enablement waits for the next Sunday; after downtime, only the latest missed report is sent. Leave the channel ID empty to disable scheduled posts; `/activity` remains available.
