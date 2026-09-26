import type { summarize } from './service.js';

export function formatSummary(result: ReturnType<typeof summarize>, title = 'Activity summary', coverage?: string) {
  const topChannels = result.channels.slice(0, 10).map(channel => `<#${channel.id}>: ${channel.count}`).join('\n') || 'No activity recorded.';
  const topUsers = result.topUsers.map((user, index) => `${index + 1}. <@${user.id}>: **${user.count}** messages`).join('\n') || 'No activity recorded.';
  const daily = result.days.slice(-14).map(day => `${day.date}: ${day.count}`).join('\n') || 'None';
  return [
    `**${title}** · <t:${Math.floor(result.from / 1000)}:f> to <t:${Math.floor(result.until / 1000)}:f>`,
    `Messages: **${result.messages}** · Active members: **${result.activeMembers}** · Active channels: **${result.channels.length}**`,
    `**Top 3 most active members**\n${topUsers}`,
    `**Top channels**\n${topChannels}`, `**Daily messages (UTC, last 14 active days)**\n${daily}`,
    coverage ?? 'Counts use stored human-message observations. Offline periods may be incomplete unless history was refreshed.',
    'Inaccessible/excluded channels and unavailable private threads are not included. Previously recorded deleted messages remain counted.',
  ].join('\n\n');
}
