/** Admission only: OpenClaw owns history, queues, tools, inference and delivery. */
export function createAdmission({ guildId, botId, mentionNames = [], windowSeconds = 300 }, currentConfig, now = Date.now) {
  const awake = new Map();
  const channelId = value => String(value ?? '').replace(/^discord:/, '').replace(/^channel:/, '');
  const allowed = id => currentConfig().channels?.discord?.guilds?.[guildId]?.channels?.[id]?.enabled === true;
  return {
    beforeDispatch(event, context) {
      if (event.channel !== 'discord') return;
      const id = channelId(context.conversationId);
      if (!allowed(id)) { awake.delete(id); return { handled: true }; }
      for (const [key, expiry] of awake) if (expiry <= now()) awake.delete(key);
      // Native Discord resolves user mentions to @globalName (or @username) before dispatch.
      const normalizedMention = mentionNames.some(name => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?:^|\\s)@${escaped}(?=$|[\\s.,!?:;])`, 'u').test(event.content ?? '');
      });
      const mentioned = normalizedMention || new RegExp(`<@!?${botId}>`).test(event.content ?? '') || event.replyToSender === botId;
      if (mentioned) {
        if (awake.size >= 100) awake.delete(awake.keys().next().value);
        awake.set(id, now() + windowSeconds * 1000);
      }
      if ((awake.get(id) ?? 0) <= now()) return { handled: true };
    },
    beforeToolCall(event, context) {
      if (event.toolName !== 'message') return;
      const match = context.sessionKey?.match(/:discord:channel:(\d+)$/);
      const source = match?.[1];
      const target = channelId(event.params?.target ?? event.params?.channelId ?? event.params?.to ?? source);
      // The assistant may read/respond here; no edits, deletion or cross-channel actions.
      if (!source || !allowed(source) || target !== source || !['read', 'send'].includes(event.params?.action)) {
        return { block: true, blockReason: 'Only reading and replying in the current enabled channel is allowed.' };
      }
    },
    sending(event, context) {
      if (context.channelId !== 'discord') return;
      if (!allowed(channelId(context.conversationId ?? event.to))) return { cancel: true };
    },
  };
}

export default {
  id: 'threesixty-channel-policy',
  name: 'ThreeSixty channel admission',
  register(api) {
    const policy = createAdmission(api.pluginConfig, () => api.runtime.config.current());
    api.on('before_dispatch', policy.beforeDispatch);
    api.on('before_tool_call', policy.beforeToolCall);
    api.on('message_sending', policy.sending);
  },
};
