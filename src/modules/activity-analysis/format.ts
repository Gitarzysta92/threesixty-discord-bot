import type { summarize } from './service.js';

export function formatSummary(result: ReturnType<typeof summarize>, title = 'Activity summary') {
  const topChannels = result.channels.slice(0, 10).map(channel => `<#${channel.id}>: ${channel.count}`).join('\n') || 'No activity recorded.';
  const daily = result.days.slice(-14).map(day => `${day.date}: ${day.count}`).join('\n') || 'None';
  return [
    `**${title}** · <t:${Math.floor(result.from / 1000)}:f> to <t:${Math.floor(result.until / 1000)}:f>`,
    `Messages: **${result.messages}** · Active members: **${result.activeMembers}** · Active channels: **${result.channels.length}**`,
    `**Top channels**\n${topChannels}`, `**Daily messages (UTC, last 14 active days)**\n${daily}`,
    'Counts cover observed human messages only. Offline periods and inaccessible/excluded channels are not included; no historical backfill.',
  ].join('\n\n');
}
