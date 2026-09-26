import { DatabaseSync } from 'node:sqlite';
import type { Destination, DestinationStore } from '../contracts/destination.js';

export function openDestinationStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS module_destinations (
      guild_id TEXT NOT NULL, module TEXT NOT NULL, channel_id TEXT, enabled_at INTEGER NOT NULL,
      PRIMARY KEY(guild_id, module)
    );`);
  return {
    forModule(guildId: string, module: string): DestinationStore {
      return {
        get() {
          const row = db.prepare('SELECT channel_id, enabled_at FROM module_destinations WHERE guild_id = ? AND module = ?').get(guildId, module);
          return row?.channel_id ? { channelId: row.channel_id, enabledAt: row.enabled_at } as unknown as Destination : null;
        },
        set(channelId, now) {
          db.prepare(`INSERT INTO module_destinations VALUES (?, ?, ?, ?)
            ON CONFLICT(guild_id, module) DO UPDATE SET channel_id=excluded.channel_id, enabled_at=excluded.enabled_at`).run(guildId, module, channelId, now);
        },
      };
    },
    close: () => db.close(),
  };
}
