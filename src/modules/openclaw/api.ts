import { z } from 'zod';

export interface ConversationRequest { session: string; content: string }
export interface OpenClawClient {
  reply(request: ConversationRequest, signal: AbortSignal): Promise<string>;
}
const responseSchema = z.object({ choices: z.array(z.object({
  message: z.object({ content: z.string().trim().min(1) }),
})).min(1) });

export function createOpenClawClient(config: { baseUrl: string; token: string; agentId: string; timeoutMs: number }, request: typeof fetch = fetch): OpenClawClient {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    async reply(input, signal) {
      try {
        const response = await request(endpoint, {
          method: 'POST', redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
          headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: `openclaw/${config.agentId}`, user: input.session, stream: false,
            messages: [{ role: 'user', content: input.content }],
          }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Unsuccessful response');
        }
        const result = responseSchema.parse(await response.json());
        return result.choices[0]!.message.content;
      } catch {
        // Never propagate provider bodies, URLs, prompts or credentials into logs.
        throw new Error('OpenClaw request failed or timed out');
      }
    },
  };
}
