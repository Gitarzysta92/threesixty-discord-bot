import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { GatewayClient } from '@openclaw/gateway-client';
import type { DeviceIdentity } from '@openclaw/gateway-client';

export interface NativeChannelPolicy { enabled: boolean; requireMention: boolean }
export interface NativeGateway {
  start(): Promise<void>;
  sync(guildId: string, channels: Record<string, NativeChannelPolicy>): Promise<void>;
  stop(): Promise<void>;
}

/** Native SDK owns transport, authentication framing, reconnects and request lifecycles. */
export function createNativeGateway(config: { url: string; token: string; identityPath: string; privateNetwork: boolean }): NativeGateway {
  let identity: DeviceIdentity;
  if (existsSync(config.identityPath)) identity = JSON.parse(readFileSync(config.identityPath, 'utf8')) as DeviceIdentity;
  else {
    const pair = generateKeyPairSync('ed25519');
    const raw = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    identity = {
      deviceId: createHash('sha256').update(raw).digest('hex'),
      privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
    writeFileSync(config.identityPath, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
  }
  let ready: Promise<void>;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  let timer: ReturnType<typeof setTimeout>;
  let queue = Promise.resolve();
  const client = new GatewayClient({
    url: config.url, token: config.token, deviceIdentity: identity,
    clientName: 'gateway-client', clientDisplayName: 'ThreeSixty channel controls', mode: 'backend',
    scopes: ['operator.admin'],
    env: config.privateNetwork ? { ...process.env, OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: '1' } : process.env,
    hostDeps: {
      signDevicePayload: (pem, payload) => sign(null, Buffer.from(payload), pem).toString('base64url'),
      publicKeyRawBase64UrlFromPem: pem => createPublicKey(pem).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'),
      logError: () => {}, logDebug: () => {},
    },
    onHelloOk(hello) {
      if (!hello.auth.scopes.includes('operator.admin')) { rejectReady(new Error('OpenClaw device lacks configuration permission')); return; }
      clearTimeout(timer); resolveReady();
    },
    onConnectError() { clearTimeout(timer); rejectReady(new Error(`OpenClaw connection failed; check pairing for device ${identity.deviceId}`)); },
  });
  return {
    async start() {
      ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      timer = setTimeout(() => rejectReady(new Error('OpenClaw connection timed out')), 15000);
      client.start();
      try { await ready; } catch (error) { client.stop(); throw error; }
    },
    sync(guildId, channels) {
      const work = queue.then(async () => {
        await ready;
        const current = await client.request<{ hash: string; config: { channels?: { discord?: { guilds?: Record<string, { channels?: Record<string, unknown> }> } } } }>('config.get', {});
        const previous = current.config.channels?.discord?.guilds?.[guildId]?.channels ?? {};
        if (JSON.stringify(previous) === JSON.stringify(channels)) return;
        const removed = Object.fromEntries(Object.keys(previous).filter(id => !(id in channels)).map(id => [id, null]));
        await client.request('config.patch', { baseHash: current.hash, raw: JSON.stringify({ channels: { discord: {
          groupPolicy: 'allowlist', guilds: { [guildId]: { requireMention: true, channels: { ...removed, ...channels } } },
        } } }), note: 'Synchronize Discord channel access' });
      });
      queue = work.catch(() => {});
      return work;
    },
    async stop() { clearTimeout(timer); await queue; await client.stopAndWait(); },
  };
}
