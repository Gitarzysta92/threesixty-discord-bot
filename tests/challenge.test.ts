import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChallengePoller, createChallengeSource, parseChallenge } from '../src/modules/reset-announcements/challenge.js';
import { RetryLater } from '../src/modules/reset-announcements/api.js';
import { openDeliveryStore } from '../src/modules/reset-announcements/store.js';

const html = readFileSync(new URL('./fixtures/tibo-28.html', import.meta.url), 'utf8');
test('reads the published daily log, ignores interactive votes, and rejects layout changes', () => {
  assert.deepEqual(parseChallenge(html), [{ day: 1, date: '2026-10-05', text: 'Waiting' }]);
  const changed = html.replace('Waiting', 'Improvement &amp; reset').replace('</span>\n      ', '</span><div class="challenge-votes">123 votes</div><button>Vote</button>\n      ');
  assert.equal(parseChallenge(changed)[0]?.text, 'Improvement & reset');
  for (const broken of ['<html>Unavailable</html>', '<ol class="challenge-ledger"></ol>', html.replace('day-1', 'day-29'), html.replace('datetime=', 'unknown=')]) {
    assert.throws(() => parseChallenge(broken));
  }
});

test('challenge HTTP failures, rate limits and cancellation do not produce data', async () => {
  assert.equal((await createChallengeSource(async () => new Response(html)).load())[0]?.day, 1);
  await assert.rejects(createChallengeSource(async () => new Response('', { status: 503 })).load(), /503/);
  await assert.rejects(createChallengeSource(async () => new Response('', { status: 429, headers: { 'Retry-After': '900' } })).load(), error => error instanceof RetryLater && error.delayMs === 900_000);
  const controller = new AbortController();
  const db = openDeliveryStore(':memory:', 'channel');
  try {
    await assert.rejects(createChallengePoller({ async load() { controller.abort(); return parseChallenge(html); } }, db.store, { async publish() { assert.fail('must not send'); } }, controller.signal)(), { name: 'AbortError' });
    assert.equal(db.store.has('challenge:tibo-28:initialized'), false);
  } finally { db.close(); }
});

test('challenge bootstraps independently, persists receipts, retries sends and posts changed days', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-'));
  const path = join(dir, 'receipts.sqlite');
  let db = openDeliveryStore(path, 'company:channel');
  let days = [...parseChallenge(html), { day: 2, date: '2026-10-06', text: 'Waiting' }];
  const sent: string[] = [];
  let fail = true;
  const publisher = { async publish(item: { content: string }) { if (fail) throw new Error('offline'); sent.push(item.content); } };
  const source = { async load() { return days; } };
  try {
    db.store.initialize([]); // Existing reset destination.
    let poll = createChallengePoller(source, db.store, publisher);
    await assert.rejects(poll(), /offline/);
    fail = false;
    await poll(); await poll();
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /Day 2 of 28/);
    db.close(); db = openDeliveryStore(path, 'company:channel');
    poll = createChallengePoller(source, db.store, publisher);
    await poll(); assert.equal(sent.length, 1);
    days[1] = { ...days[1]!, text: 'Improvement: faster tools' };
    await poll(); await poll(); assert.equal(sent.length, 2);
    days.push({ day: 3, date: '2026-10-07', text: 'Waiting' });
    await poll(); assert.equal(sent.length, 3);
    days[2] = { ...days[2]!, text: 'Reset' };
    await poll(); assert.equal(sent.length, 4);
    assert.match(sent[3]!, /tibo-28#day-3/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
