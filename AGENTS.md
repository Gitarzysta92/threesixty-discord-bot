# Project guidance

## OpenClaw integration

Use OpenClaw’s native functionality for conversations, channel history, sessions,
message grouping, participation decisions, tools, and automation. Inspect the
installed version’s documentation and capabilities before adding custom behavior.
Do not build a parallel agent runtime in this Discord bot. Keep repository code
focused on existing company features and the minimal integration needed to use
OpenClaw. If the requested behavior has no native equivalent, explain that gap
and keep any necessary custom integration narrowly scoped.

Preserve the administrator-managed channel access controls. Changing participation
behavior must not silently enable additional channels.
