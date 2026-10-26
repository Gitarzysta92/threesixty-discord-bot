# Read-only Kuma status tool

The existing Discord agent can use `kuma_status` only within channels already
enabled by `/tclaw-channel`. The tool returns active monitor status, rolling
24-hour availability, and average response time. It has no mutation methods,
arbitrary URL input, raw monitor URLs, or dashboard session. Paused monitors
do not appear in Kuma's metrics endpoint.

The Coolify host cannot currently reach Kuma's private Tailscale address.
Use the public HTTPS `/metrics` path with two separate credentials:

1. Create a dedicated Uptime Kuma Prometheus API key for this bot. Enable
   API-key authentication for `/metrics`; do not use the admin password.
2. Create a Cloudflare Access service token and a self-hosted application
   scoped to exactly `kuma.threesixty.dev/metrics`. Its Service Auth policy
   must accept only this token. Preserve the existing human-only Access
   application for the rest of `kuma.threesixty.dev`.
3. Store `KUMA_METRICS_API_KEY`, `KUMA_CF_ACCESS_CLIENT_ID`, and
   `KUMA_CF_ACCESS_CLIENT_SECRET` as masked Coolify environment values on the
   OpenClaw service. Do not put them into Compose source, OpenClaw config,
   agent instructions, Discord, or Git.
4. Verify that `/metrics` returns Prometheus text with those credentials and
   that the same service token still receives the Access login response at
   `/dashboard`. Then redeploy OpenClaw and verify the tool from a private
   non-delivering agent turn before using it in Discord.

The plugin uses only HTTPS, refuses redirects and HTML, limits response size
and time, and returns a generic error when Kuma is unavailable. Its secret
values remain in the Gateway process environment, so keep the bot's tool
allowlist restricted to `message` and `kuma_status`. A future shell-capable
agent should run separately with its own credentials and state.
