import { DatabaseSync } from 'node:sqlite';
import type { SummaryDeliveryStore } from '../modules/activity-analysis/schedule.js';

export function openSummaryDeliveryStore(path: string, destination: string, now = Date.now()) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS summary_destinations (destination TEXT PRIMARY KEY, enabled_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS summary_deliveries (destination TEXT, period_end INTEGER, PRIMARY KEY(destination, period_end));`);
  db.prepare('INSERT OR IGNORE INTO summary_destinations VALUES (?, ?)').run(destination, now);
  const store: SummaryDeliveryStore = {
    enabledAt: () => db.prepare('SELECT enabled_at FROM summary_destinations WHERE destination = ?').get(destination)!.enabled_at as number,
    has: periodEnd => !!db.prepare('SELECT 1 FROM summary_deliveries WHERE destination = ? AND period_end = ?').get(destination, periodEnd),
    mark: periodEnd => { db.prepare('INSERT OR IGNORE INTO summary_deliveries VALUES (?, ?)').run(destination, periodEnd); },
  };
  return { store, close: () => db.close() };
}
