import type { HistoryCoverage } from '../contracts/activity-refresh.js';
import { DatabaseSync } from 'node:sqlite';
import type { ActivityReader, ActivityWriter, MessageActivity } from '../contracts/activity.js';

export function openActivityStore(path: string, now = Date.now()) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS activity_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS history_coverage (guildId TEXT NOT NULL, channelId TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL);
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
    prune(before) { remove.run(before); db.prepare('DELETE FROM history_coverage WHERE end <= ?').run(before); db.prepare('UPDATE history_coverage SET start = MAX(start, ?)').run(before); },
  };
  const reader: ActivityReader = {
    *read(guildId, from, until) {
      for (const row of select.iterate(guildId, from, until)) yield row as unknown as MessageActivity;
    },
    collectionStartedAt() {
      return db.prepare('SELECT value FROM activity_metadata WHERE key = ?').get('startedAt')!.value as number;
    },
  };
  const coverage: HistoryCoverage = {
    ranges(guildId, channelId) {
      return db.prepare('SELECT start AS "from", end AS until FROM history_coverage WHERE guildId = ? AND channelId = ? ORDER BY start').all(guildId, channelId).map(row => ({ from: Number(row.from), until: Number(row.until) }));
    },
    mark(guildId, channelId, from, until) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const overlaps = db.prepare('SELECT MIN(start) AS start, MAX(end) AS end FROM history_coverage WHERE guildId = ? AND channelId = ? AND end >= ? AND start <= ?').get(guildId, channelId, from, until)!;
        db.prepare('DELETE FROM history_coverage WHERE guildId = ? AND channelId = ? AND end >= ? AND start <= ?').run(guildId, channelId, from, until);
        db.prepare('INSERT INTO history_coverage VALUES (?, ?, ?, ?)').run(guildId, channelId, Math.min(from, Number(overlaps.start ?? from)), Math.max(until, Number(overlaps.end ?? until)));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return { writer, reader, coverage, close: () => db.close() };
}
