import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestWeeklyWindow, createWeeklyTick } from '../src/modules/activity-analysis/schedule.js';
import { openSummaryDeliveryStore } from '../src/storage/summary-delivery-store.js';
import type { ActivityReader } from '../src/contracts/activity.js';

const timestamp = (value: string) => Date.parse(value);
test('weekly schedule fires at Sunday noon Warsaw in summer and winter', () => {
  assert.equal(latestWeeklyWindow(timestamp('2026-09-27T09:59:59Z')).until, timestamp('2026-09-20T10:00:00Z'));
  assert.equal(latestWeeklyWindow(timestamp('2026-09-27T10:00:00Z')).until, timestamp('2026-09-27T10:00:00Z'));
  assert.equal(latestWeeklyWindow(timestamp('2026-12-27T11:00:00Z')).until, timestamp('2026-12-27T11:00:00Z'));
  assert.equal(latestWeeklyWindow(timestamp('2026-09-28T15:00:00Z')).until, timestamp('2026-09-27T10:00:00Z'));
});

test('report windows remain Sunday noon to Sunday noon across DST changes', () => {
  const spring = latestWeeklyWindow(timestamp('2026-03-29T10:00:00Z'));
  assert.equal(spring.from, timestamp('2026-03-22T11:00:00Z'));
  assert.equal((spring.until - spring.from) / 3_600_000, 167);
  const autumn = latestWeeklyWindow(timestamp('2026-10-25T11:00:00Z'));
  assert.equal(autumn.from, timestamp('2026-10-18T10:00:00Z'));
  assert.equal((autumn.until - autumn.from) / 3_600_000, 169);
});

test('weekly deliveries wait for first due date, retry failures and survive restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weekly-summary-'));
  const path = join(directory, 'summaries.sqlite');
  let now = timestamp('2026-09-26T12:00:00Z');
  let db = openSummaryDeliveryStore(path, 'company:reports', now);
  const windows: number[][] = [];
  const reader: ActivityReader = {
    collectionStartedAt: () => timestamp('2026-09-01T00:00:00Z'),
    read(_guild, from, until) { windows.push([from, until]); return []; },
  };
  const sent: { content: string; nonce: string }[] = [];
  let fail = true;
  const publisher = { async publish(content: string, nonce: string) {
    if (fail) throw new Error('Discord unavailable');
    sent.push({ content, nonce });
  } };
  const tick = () => createWeeklyTick(reader, 'company', 90, { store: db.store, publisher, destination: 'company:reports' }, () => now)();
  try {
    await tick();
    assert.equal(sent.length, 0);
    assert.equal(windows.length, 0);
    now = timestamp('2026-09-27T10:00:00Z');
    await assert.rejects(tick(), /Discord unavailable/);
    assert.equal(db.store.has(now), false);
    fail = false;
    await tick(); await tick();
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.content, /Weekly activity summary/);
    assert.deepEqual(windows[0], [timestamp('2026-09-20T10:00:00Z'), now]);
    db.close(); db = openSummaryDeliveryStore(path, 'company:reports', now + 60_000);
    await tick();
    assert.equal(sent.length, 1);
    // After downtime, send only the most recently due period.
    now = timestamp('2026-10-12T08:00:00Z');
    await tick();
    assert.equal(sent.length, 2);
    assert.notEqual(sent[0]!.nonce, sent[1]!.nonce);
    assert.equal(db.store.has(timestamp('2026-10-11T10:00:00Z')), true);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('summary acknowledges when the whole due period predates retained data', async () => {
  const end = timestamp('2026-09-27T10:00:00Z');
  const db = openSummaryDeliveryStore(':memory:', 'company:reports', end);
  const reader: ActivityReader = { collectionStartedAt: () => end + 1000, read() { throw new Error('Must not read invalid range'); } };
  let content = '';
  try {
    await createWeeklyTick(reader, 'company', 1, { store: db.store, destination: 'company:reports', publisher: { async publish(value) { content = value; } } }, () => end + 2 * 86_400_000)();
    assert.match(content, /No retained collection data/);
    assert.equal(db.store.has(end), true);
  } finally { db.close(); }
});
