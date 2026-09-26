import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResetSource, RetryLater } from '../src/modules/reset-announcements/api.js';
import type { Reset, ResetSnapshot } from '../src/modules/reset-announcements/api.js';
import { openDeliveryStore } from '../src/modules/reset-announcements/store.js';
import { createResetPoller } from '../src/modules/reset-announcements/service.js';

const reset = (id: string, date: string): Reset => ({ id, announced_at: date, reset_type: 'regular', text: '', source: { type: 'observed' } });
const old = reset('old', '2026-09-01T00:00:00Z');
const latest = reset('latest', '2026-09-02T00:00:00Z');

test('reset delivery bootstraps latest only, persists deduplication and retries failed posts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reset-test-'));
  const path = join(dir, 'resets.sqlite');
  let db = openDeliveryStore(path, 'company:channel');
  let snapshot: ResetSnapshot = { resets: [latest, old], scheduled: null };
  const sent: string[] = [];
  let fail = false;
  const publisher = { async publish(item: { key: string; content: string }) {
    if (fail) throw new Error('Discord unavailable');
    assert.match(item.content, /codex-resets.com/);
    sent.push(item.key);
  } };
  const source = { async load() { return snapshot; } };
  try {
    let poll = createResetPoller(source, db.store, publisher);
    await poll(); await poll();
    assert.deepEqual(sent, ['completed:latest:regular']);
    db.close(); db = openDeliveryStore(path, 'company:channel');
    poll = createResetPoller(source, db.store, publisher);
    await poll();
    assert.equal(sent.length, 1);
    snapshot = { resets: [reset('new', '2026-09-03T00:00:00Z'), latest, old], scheduled: null };
    fail = true;
    await assert.rejects(poll(), /Discord unavailable/);
    assert.equal(db.store.has('completed:new:regular'), false);
    fail = false; await poll();
    assert.equal(sent.length, 2);
    snapshot.scheduled = { ...reset('future', '2026-09-04T00:00:00Z'), status: 'scheduled', scheduled_for: null };
    await poll(); await poll();
    assert.equal(sent.length, 3);
    snapshot.scheduled.scheduled_for = '2026-09-05T00:00:00Z';
    await poll();
    assert.equal(sent.length, 4);
    snapshot.resets.push(reset('future', '2026-09-05T00:00:00Z'));
    await poll();
    assert.equal(sent.at(-1), 'completed:future:regular');
    assert.equal(sent.length, 5);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('API handles pagination and rejects invalid schemas without publishing partial data', async () => {
  const urls: string[] = [];
  const source = createResetSource((async (url: string | URL | Request) => {
    urls.push(String(url));
    if (String(url).endsWith('status')) return Response.json({ data: { scheduled_reset: null } });
    return Response.json({ data: [urls.length === 2 ? latest : old], pagination: { has_more: urls.length === 2, next_cursor: urls.length === 2 ? 'page2' : null } });
  }) as typeof fetch);
  assert.equal((await source.load()).resets.length, 2);
  assert.match(urls[2]!, /cursor=page2/);
  await assert.rejects(createResetSource(async () => Response.json({ broken: true })).load());
  await assert.rejects(createResetSource(async () => new Response('', { status: 503 })).load(), /503/);
});

test('API respects rate-limit retry time', async () => {
  const source = createResetSource(async () => new Response('', { status: 429, headers: { 'Retry-After': '900' } }));
  await assert.rejects(source.load(), error => error instanceof RetryLater && error.delayMs === 900_000);
});

test('shutdown cancels a poll without publishing or marking unseen announcements', async () => {
  const controller = new AbortController();
  const db = openDeliveryStore(':memory:', 'channel');
  let published = false;
  try {
    const poll = createResetPoller({ async load() {
      controller.abort();
      return { resets: [latest], scheduled: null };
    } }, db.store, { async publish() { published = true; } }, controller.signal);
    await assert.rejects(poll(), { name: 'AbortError' });
    assert.equal(published, false);
    assert.equal(db.store.initialized(), false);
  } finally { db.close(); }
});
