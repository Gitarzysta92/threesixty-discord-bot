import { DatabaseSync } from 'node:sqlite';
import type { ActivityReader, ActivityWriter, MessageActivity } from '../contracts/activity.js';

export function openActivityStore(path: string, now = Date.now()) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS activity_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS message_activity (
      messageId TEXT PRIMARY KEY, guildId TEXT NOT NULL, channelId TEXT NOT NULL,
      userId TEXT NOT NULL, occurredAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_range ON message_activity(guildId, occurredAt);
  `);
  db.prepare('INSERT OR IGNORE INTO activity_metadata VALUES (?, ?)').run('startedAt', now);
  const insert = db.prepare('INSERT OR IGNORE INTO message_activity VALUES (?, ?, ?, ?, ?)');
  const select = db.prepare('SELECT * FROM message_activity WHERE guildId = ? AND occurredAt >= ? AND occurredAt < ? ORDER BY occurredAt');
  const remove = db.prepare('DELETE FROM message_activity WHERE occurredAt < ?');
  const writer: ActivityWriter = {
    record(event) { insert.run(event.messageId, event.guildId, event.channelId, event.userId, event.occurredAt); },
    prune(before) { remove.run(before); },
  };
  const reader: ActivityReader = {
    *read(guildId, from, until) {
      for (const row of select.iterate(guildId, from, until)) yield row as unknown as MessageActivity;
    },
    collectionStartedAt() {
      return db.prepare('SELECT value FROM activity_metadata WHERE key = ?').get('startedAt')!.value as number;
    },
  };
  return { writer, reader, close: () => db.close() };
}
