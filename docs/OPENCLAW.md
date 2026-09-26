# OpenClaw channel participation

The optional `src/modules/openclaw/` module connects the existing Discord bot to a separately running OpenClaw Gateway. OpenClaw owns the agent, sessions and model configuration:

```text
Discord -> this bot's openclaw module -> OpenClaw Gateway -> LiteLLM -> Qwen
```

## Behavior

- Disabled by default. Set `OPENCLAW_PUBLIC_CHANNELS=true` to include all company-server channels visible to `@everyone`, plus public threads in those channels. Private threads and channels hidden from `@everyone` are excluded. Alternatively, explicit `OPENCLAW_CHANNEL_IDS` allow chosen channels and their accessible threads, including private ones. Leave that list empty for public-only participation.
- Responds to direct bot mentions and same-channel replies to this bot. Other bots, webhooks, system messages, role/everyone mentions and ordinary conversation do not trigger answers.
- Sends the addressed message (up to 4,000 characters), author ID and the referenced same-channel message when available (up to 2,000 characters). It does not scan surrounding history or send attachments.
- Each channel/thread has a separate stable OpenClaw session shared by its participants. OpenClaw controls session persistence and retention.
- One request per room and at most four rooms run concurrently. Additional messages while busy are ignored; retry after the answer arrives. Requests time out after 60 seconds by default, without automatic retries.
- Replies disable mentions and are split into at most four Discord messages. Shutdown aborts local requests and suppresses subsequent replies. An HTTP disconnect may not cancel an already-running remote agent.

Activity collection still stores metadata only. This feature additionally transmits message text to OpenClaw and its model backend. OpenClaw and LiteLLM may retain transcripts/logs according to their configuration. Select channels whose participants can share conversation context and configure retention on those services.

## Configure OpenClaw and LiteLLM

Run a dedicated OpenClaw instance with its own state/workspace. This repository supplies the client module, not an embedded OpenClaw runtime. This process owns the Discord connection; do not also configure OpenClaw's native Discord integration with this bot's token.

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

4. Restart the bot. No slash-command deployment is required. Mention it in an allowed channel, then reply to its answer. Verify silence in other channels and separate context between threads.

The base URL points to OpenClaw, including `/v1`, not LiteLLM. The LiteLLM key stays with OpenClaw. In Docker/Coolify, `127.0.0.1` means the bot container: use the Gateway's reachable private service hostname and configure its listener/network accordingly. Use HTTPS over an untrusted network. Persist OpenClaw state separately from the bot data volume.

Set `OPENCLAW_ENABLED=false` and restart to disable participation. Removing a channel stops new participation after restart but does not erase its existing OpenClaw session.

## Validation

`npm run check` tests configuration, filtering, HTTP behavior, session identity, failures, reply limits and shutdown with mocks. Live Discord/OpenClaw/LiteLLM behavior needs configured services and credentials and is not exercised by this suite.

## Deployed Coolify service

The reproducible service definition is [`deployment/openclaw/compose.yaml`](../deployment/openclaw/compose.yaml). It runs official OpenClaw `2026.9.6` as a separate `threesixty-openclaw` service in the bot's production environment, with persistent state and no published ports or domain. The service joins the bot network and the existing LiteLLM gateway network. The network names in this deployment file are specific to the current Coolify resources.

OpenClaw uses LiteLLM's `qwen3.5:9b` alias with a dedicated inference key restricted to that model. Both secrets are stored in Coolify environment variables, not in this repository. The bot connects to `http://threesixty-openclaw:18789/v1`. LiteLLM must be running for replies to work.

The startup script writes managed configuration and the assistant instructions into the state volume. Change that script and redeploy the service to update them; manual edits to those files are replaced at restart. Session state remains persistent. The agent denies all tools and disables browser control. The Gateway control UI is disabled because this deployment only needs the authenticated HTTP endpoint.

To reproduce: create a custom Compose service from this file in the existing bot project, set `OPENCLAW_GATEWAY_TOKEN` and a model-restricted `LITELLM_API_KEY`, and start it. Then set the bot's `OPENCLAW_TOKEN` to the same Gateway token, `OPENCLAW_BASE_URL` to the private URL above, `OPENCLAW_PUBLIC_CHANNELS=true`, `OPENCLAW_TIMEOUT_SECONDS=120`, and `OPENCLAW_ENABLED=true`. Leave `OPENCLAW_CHANNEL_IDS` empty to exclude private rooms. Ensure Message Content Intent is enabled before restarting the bot. Do not expose this Gateway through a public domain or mount a Docker socket into it.
