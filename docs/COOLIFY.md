# Coolify deployment

Deploy this repository as a **Docker Compose application**, following the same server/environment-variable/persistent-volume pattern as LiteLLM. Use `/compose.yaml`, branch `main`, base directory `/`. The bot is an outbound Discord gateway worker: leave Domains and host port mappings empty. No Cloudflare tunnel route is needed for the bot itself.

The multi-stage Dockerfile runs typecheck, tests, and compilation, then installs only production dependencies into a Node 22 image. The worker runs as the non-root `node` user. Secrets and local databases are excluded from the build context.

Set these runtime variables in Coolify (never as build arguments):

- `DISCORD_TOKEN`: token of a dedicated Discord bot application.
- `DISCORD_APPLICATION_ID`: its application ID.
- `DISCORD_GUILD_ID`: the company server ID.

Configure destinations from Discord after registering commands: `/resets enable` and `/activity-summary enable`, optionally selecting a `channel`. Both start disabled and support `status` and `disable`; changes require no restart. Polling defaults to 300 seconds; summaries run Sundays at 12:00 Europe/Warsaw. Other optional settings are documented in `.env.example`. Keep `DATA_DIR=/app/data`; the Compose `bot-data` named volume holds the SQLite databases, including channel settings and must persist across deployments. A fresh named volume inherits ownership from the image's `/app/data` directory. A manually supplied bind mount must be writable by UID 1000.

Run only one instance. Keep preview deployments and automatic deployments disabled until explicitly configured. No HTTP health check is applicable: verify `Bot ready` in logs and `/ping` in Discord. A container running does not alone prove Discord readiness. Coolify's HTTP health-check setting should remain off.

After the first successful start, run this in the bot container terminal:

```sh
node dist/deploy-commands.js
```

It registers the enabled slash commands in the configured guild and replaces this application's guild command list. Repeat after changing command metadata or enablement. Registration is intentionally separate from every process restart.

For later releases, push to `main` and select Deploy in Coolify. The image build executes the test suite. Ensure the old worker stops before the replacement starts; Compose recreation keeps one service instance. Verify the mounted volume survives a restart. Back up the databases while stopped or with SQLite backup tools; do not copy active WAL databases without their journals.

The local Docker daemon was unavailable during initial preparation. `npm run check`, the compiled registration dry run, and Compose schema validation were run locally; the first Coolify image build remains the container validation step until deployment succeeds.
