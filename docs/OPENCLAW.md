# OpenClaw channel participation

The optional `src/modules/openclaw/` module connects the existing Discord bot to a separately running OpenClaw Gateway. OpenClaw owns the agent, sessions and model configuration:

```text
Discord -> this bot's openclaw module -> OpenClaw Gateway -> LiteLLM -> Qwen
```

## Native Discord mode

Production uses OpenClaw's official `@openclaw/discord` plugin for chat. This bot
retains its activity/reset features and `/tclaw-channel` administration. Set
`OPENCLAW_NATIVE_DISCORD=true` to disable the legacy message/HTTP reply handler.
`/tclaw` then gives a private reminder to mention the bot directly.

OpenClaw retrieves up to 20 recent channel messages using native Discord history,
keeps native per-channel/thread sessions, groups incoming messages, and decides
when to speak. Summaries describe this recent window, not the entire channel or
activity database. The native message tool can read more messages in the current
channel when needed. DMs and other bots are disabled.

A small OpenClaw plugin in `deployment/openclaw/channel-policy` handles only the
missing admission rule: a bot mention opens a five-minute window for that exact
channel, renewed by another mention. Outside it, unmentioned messages do not
reach model dispatch. During it, native ambient room events let OpenClaw choose
whether to send a message. No custom history buffer, model loop or reply-decision
protocol is implemented here. A restart forgets attention windows but preserves
OpenClaw sessions.

The same plugin requires an exact enabled channel entry, preventing native parent
fallback from admitting unknown private threads. It limits message tools to
`read` and `send` in the current enabled channel and blocks delivery to disabled
channels. Other tools remain unavailable. Existing activity storage stays metadata-only;
OpenClaw and the model backend process message text and may retain it.

## Change channel access in Discord

Administrators can use `/tclaw-channel enable`, `disable`, `status`, or `reset`.
Every action accepts an optional `channel`; omit it for the current channel.
Explicit overrides take precedence over public-channel/environment defaults.
Public means visible to `@everyone`; private threads are excluded unless explicitly
allowed or inherited from an explicit parent override.

Overrides persist in `DATA_DIR/openclaw-settings.sqlite`. In native mode, the bot
syncs effective access to OpenClaw through its official Gateway client SDK at
startup, on access changes, and after Discord channel/role events. Failed admin
updates restore local settings and report failure instead of claiming success.
New channels/threads stay blocked by the admission plugin until synchronized.

The Gateway client stores an Ed25519 identity in `DATA_DIR/openclaw-device.json`.
Pair that device once through OpenClaw's native device-pairing controls and grant
`operator.admin` for configuration updates. The Gateway remains private. Enable
`OPENCLAW_PRIVATE_NETWORK=true` only on its trusted private Docker network; use
`wss://` over untrusted networks.

## Production configuration

The reproducible service definition is `deployment/openclaw/compose.yaml`. It runs
OpenClaw `2026.9.6` with persistent state and no published ports or domain. It joins
the bot and LiteLLM private Docker networks. OpenClaw uses LiteLLM's `qwen3.5:9b`
alias and a dedicated inference key; all credentials live in Coolify.

The company bot uses:

```dotenv
OPENCLAW_ENABLED=true
OPENCLAW_NATIVE_DISCORD=true
OPENCLAW_GATEWAY_URL=ws://threesixty-openclaw:18789
OPENCLAW_PRIVATE_NETWORK=true
OPENCLAW_PUBLIC_CHANNELS=true
OPENCLAW_CHANNEL_IDS=
```

Set `OPENCLAW_TOKEN` to the private Gateway credential. The service also needs the
existing Discord token/application/guild IDs. Enable Message Content Intent and
grant View Channel, Read Message History, Send Messages, and Send Messages in
Threads as applicable. Server Members Intent is not requested.

The service startup script writes managed config and assistant instructions while
preserving synchronized channel rules. It allows only the native message tool;
the admission plugin further limits it to reading and sending in the current
enabled channel. Browser control, DMs, native/text command registration and server
join introductions are disabled. The company bot remains the owner of its slash
commands; activity and reset modules are unchanged.

For rollback, stop native Discord handling before setting
`OPENCLAW_NATIVE_DISCORD=false`. The legacy HTTP bridge remains available but has
no automatic channel-history access. Never activate both conversational handlers
at once. Disabling only the company bot does not stop the separate native Gateway.

`npm run check` covers configuration, access overrides, native policy sync,
attention expiry, tool restrictions, and legacy adapter behavior. Live service
verification is separate and does not send test messages into Discord.

## Deploy native integration

Install the pinned official plugin once in the persistent OpenClaw service:
`openclaw plugins install @openclaw/discord@2026.9.6`.

Edit `compose.template.yaml` and the local channel-policy plugin, then run
`node deployment/openclaw/render-compose.mjs` to regenerate `compose.yaml`.
The rendered service writes the plugin and managed configuration at startup while
preserving synchronized channel rules and existing plugin configuration. Supply
the existing Discord bot token/application/guild IDs through Coolify secrets.
Set `OPENCLAW_NATIVE_DISCORD_ENABLED=true` for the Gateway only after the company
bot is running in native mode, to avoid duplicate replies during migration.

Validate configuration before applying it. Confirm both services are ready,
channel policies match, disabled-channel admission is rejected, and native history
retrieval succeeds. No live Discord test messages should be sent without permission.
