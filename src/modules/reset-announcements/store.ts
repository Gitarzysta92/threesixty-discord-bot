import { DatabaseSync } from 'node:sqlite';

export interface DeliveryStore {
  initialized(): boolean;
  initialize(historicalKeys: string[]): void;
  has(key: string): boolean;
  mark(key: string): void;
}

export function openDeliveryStore(path: string, destination: string) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS reset_destinations (destination TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS reset_deliveries (destination TEXT, key TEXT, PRIMARY KEY(destination, key));`);
  const mark = (key: string) => { db.prepare('INSERT OR IGNORE INTO reset_deliveries VALUES (?, ?)').run(destination, key); };
  const store: DeliveryStore = {
    initialized: () => !!db.prepare('SELECT 1 FROM reset_destinations WHERE destination = ?').get(destination),
    initialize(keys) {
      db.exec('BEGIN');
      try {
        for (const key of keys) mark(key);
        db.prepare('INSERT INTO reset_destinations VALUES (?)').run(destination);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    has: key => !!db.prepare('SELECT 1 FROM reset_deliveries WHERE destination = ? AND key = ?').get(destination, key),
    mark,
  };
  return { store, close: () => db.close() };
}
