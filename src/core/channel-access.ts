/** Persistent per-channel overrides; undefined falls back to configured defaults. */
export interface ChannelAccessStore {
  get(channelId: string): boolean | undefined;
  set(channelId: string, enabled: boolean): void;
  reset(channelId: string): void;
}
