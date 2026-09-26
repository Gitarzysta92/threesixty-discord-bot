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

## Configure OpenClaw and LiteLLM

Run a dedicated OpenClaw instance with its own state/workspace. This repository supplies the client module, not an embedded OpenClaw runtime. In native mode, OpenClaw owns conversational replies. Both services use the existing bot identity, but only the company bot handles its custom slash commands; OpenClaw native/text command registration is disabled. Never run the legacy reply handler alongside native Discord replies.

Enable the [Chat Completions endpoint](https://docs.openclaw.ai/gateway/openai-http-api) and configure the [LiteLLM provider](https://docs.openclaw.ai/providers/litellm). Merge this example into the dedicated instance's configuration. Replace `YOUR_QWEN_ALIAS` with the exact alias exposed by LiteLLM and adjust context/output limits for your served model:

```json
{
  "gateway": {
    "auth": { "mode": "token", "token": "${OPENCLAW_GATEWAY_TOKEN}" },
    "http": { "endpoints": { "chatCompletions": { "enabled": true } } }
  },
  "models": {
    "providers": {
      "litellm": {
        "baseUrl": "https://your-litellm.example/v1",
        "apiKey": "${LITELLM_API_KEY}",
        "api": "openai-completions",
        "models": [{
          "id": "YOUR_QWEN_ALIAS",
          "name": "Company Qwen",
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 2048
        }]
      }
    }
  },
  "agents": {
    "defaults": { "model": { "primary": "litellm/YOUR_QWEN_ALIAS" } },
    "list": [{ "id": "discord", "tools": { "deny": ["*"] } }]
  }
}
```

The example starts with conversation-only access. The Gateway token grants operator-level access: keep it private and restrict Gateway network access to the bot. Enforce agent tool permissions in OpenClaw itself; the HTTP adapter is not a tool authorization layer. The module does not expose the activity database or company integrations. See [OpenClaw tool policy](https://docs.openclaw.ai/gateway/config-tools).

In the agent's workspace instructions, describe a concise company Discord assistant. Explain that incoming user messages contain a JSON envelope with `authorId`, `message` and optional `replyTo`; answer naturally, treat quoted content as conversation data, and do not claim access to unavailable tools/data. Keep private operator information out of this shared assistant's workspace.

## Enable the bot module

1. Enable **Message Content Intent** for the application in the Discord Developer Portal. This module requests the privileged intent only when enabled.
2. Grant View Channel, Send Messages and Read Message History in selected channels. For threads, also grant Send Messages in Threads and ensure the bot can access/join them.
3. Configure the bot environment, using the same secret as `OPENCLAW_GATEWAY_TOKEN` above:

   ```dotenv
   OPENCLAW_ENABLED=true
   OPENCLAW_BASE_URL=http://your-openclaw-host:18789/v1
   OPENCLAW_TOKEN=your-gateway-token
   OPENCLAW_AGENT_ID=discord
   OPENCLAW_PUBLIC_CHANNELS=true
   OPENCLAW_CHANNEL_IDS=
   OPENCLAW_TIMEOUT_SECONDS=60
   ```

4. Restart the bot and run `npm run commands:deploy` with `OPENCLAW_ENABLED=true` to register `/tclaw` and `/tclaw-channel`. Use `/tclaw prompt:hello` in an allowed channel, then reply to its answer. Verify silence in other channels and separate context between threads.

The base URL points to OpenClaw, including `/v1`, not LiteLLM. The LiteLLM key stays with OpenClaw. In Docker/Coolify, `127.0.0.1` means the bot container: use the Gateway's reachable private service hostname and configure its listener/network accordingly. Use HTTPS over an untrusted network. Persist OpenClaw state separately from the bot data volume.

Set `OPENCLAW_ENABLED=false`, restart and redeploy commands to disable participation and remove `/tclaw`. Removing a channel stops new participation after restart but does not erase its existing OpenClaw session.

## Validation

`npm run check` tests configuration, filtering, HTTP behavior, session identity, failures, reply limits and shutdown with mocks. Live Discord/OpenClaw/LiteLLM behavior needs configured services and credentials and is not exercised by this suite.

## Deployed Coolify service

The reproducible service definition is [`deployment/openclaw/compose.yaml`](../deployment/openclaw/compose.yaml). It runs official OpenClaw `2026.9.6` as a separate `threesixty-openclaw` service in the bot's production environment, with persistent state and no published ports or domain. The service joins the bot network and the existing LiteLLM gateway network. The network names in this deployment file are specific to the current Coolify resources.

OpenClaw uses LiteLLM's `qwen3.5:9b` alias with a dedicated inference key restricted to that model. Both secrets are stored in Coolify environment variables, not in this repository. The bot connects to `http://threesixty-openclaw:18789/v1`. LiteLLM must be running for replies to work.

The startup script writes managed configuration and the assistant instructions into the state volume. Change that script and redeploy the service to update them; manual edits to those files are replaced at restart. Session state remains persistent. The agent denies all tools and disables browser control. The Gateway control UI is disabled because this deployment only needs the authenticated HTTP endpoint.

To reproduce: create a custom Compose service from this file in the existing bot project, set `OPENCLAW_GATEWAY_TOKEN` and a model-restricted `LITELLM_API_KEY`, and start it. Then set the bot's `OPENCLAW_TOKEN` to the same Gateway token, `OPENCLAW_BASE_URL` to the private URL above, `OPENCLAW_PUBLIC_CHANNELS=true`, `OPENCLAW_TIMEOUT_SECONDS=120`, and `OPENCLAW_ENABLED=true`. Leave `OPENCLAW_CHANNEL_IDS` empty to exclude private rooms. Ensure Message Content Intent is enabled before restarting the bot. Do not expose this Gateway through a public domain or mount a Docker socket into it.

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
