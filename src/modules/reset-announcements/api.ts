import { z } from 'zod';

const sourceSchema = z.object({ type: z.enum(['x_post', 'observed']), url: z.string().url().optional() });
export const resetSchema = z.object({
  id: z.string().min(1).max(64), reset_type: z.enum(['regular', 'banked']),
  announced_at: z.string().datetime({ offset: true }), text: z.string(), source: sourceSchema,
});
const statusSchema = z.object({ data: z.object({
  scheduled_reset: resetSchema.extend({ status: z.literal('scheduled'), scheduled_for: z.string().datetime({ offset: true }).nullable() }).nullable(),
}) });
const listSchema = z.object({ data: z.array(resetSchema), pagination: z.object({ has_more: z.boolean(), next_cursor: z.string().nullable() }) });
export type Reset = z.infer<typeof resetSchema>;
export type ScheduledReset = z.infer<typeof statusSchema>['data']['scheduled_reset'];
export interface ResetSnapshot { resets: Reset[]; scheduled: ScheduledReset }
export interface ResetSource { load(): Promise<ResetSnapshot> }

export class RetryLater extends Error {
  constructor(public readonly delayMs: number) { super('Reset API rate limited'); }
}

export function createResetSource(fetcher: typeof fetch = fetch, signal?: AbortSignal): ResetSource {
  async function get(path: string) {
    const response = await fetcher(`https://codex-resets.com/api/v1/${path}`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), headers: { Accept: 'application/json' },
    });
    if (response.status === 429) {
      const raw = response.headers.get('retry-after');
      const seconds = Number(raw);
      const delay = raw && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw ?? '') - Date.now();
      throw new RetryLater(Number.isFinite(delay) ? Math.max(60_000, delay) : 300_000);
    }
    if (!response.ok) throw new Error(`Reset API returned HTTP ${response.status}`);
    return response.json();
  }
  return {
    async load() {
      const status = statusSchema.parse(await get('status'));
      const resets: Reset[] = [];
      let cursor: string | null = null;
      const cursors = new Set<string>();
      // Bound work if upstream pagination malfunctions; never persist a partial snapshot.
      for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ limit: '100', order: 'desc' });
        if (cursor) query.set('cursor', cursor);
        const result = listSchema.parse(await get(`resets?${query}`));
        resets.push(...result.data);
        if (!result.pagination.has_more) return { resets, scheduled: status.data.scheduled_reset };
        cursor = result.pagination.next_cursor;
        if (!cursor || cursors.has(cursor)) throw new Error('Invalid reset pagination cursor');
        cursors.add(cursor);
      }
      throw new Error('Reset pagination exceeded safety limit');
    },
  };
}
