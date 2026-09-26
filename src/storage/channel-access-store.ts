import { DatabaseSync } from 'node:sqlite';
import type { ChannelAccessStore } from '../core/channel-access.js';

export function openChannelAccessStore(path: string, guildId: string) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS openclaw_channels (
      guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, enabled INTEGER NOT NULL,
      PRIMARY KEY (guild_id, channel_id)
    );`);
  const store: ChannelAccessStore = {
    get(channelId) {
      const row = db.prepare('SELECT enabled FROM openclaw_channels WHERE guild_id = ? AND channel_id = ?').get(guildId, channelId);
      return row ? row.enabled === 1 : undefined;
    },
    set(channelId, enabled) {
      db.prepare('INSERT INTO openclaw_channels VALUES (?, ?, ?) ON CONFLICT(guild_id, channel_id) DO UPDATE SET enabled = excluded.enabled').run(guildId, channelId, enabled ? 1 : 0);
    },
    reset(channelId) { db.prepare('DELETE FROM openclaw_channels WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId); },
  };
  return { store, close: () => db.close() };
}
