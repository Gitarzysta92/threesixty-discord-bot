/** Analysis requests collection through this boundary, without importing a collector. */
export interface ActivityRefreshResult { checked: number; incomplete: number; discoveryIncomplete: boolean }
export interface ActivityRefresher {
  refresh(from: number, until: number): Promise<ActivityRefreshResult>;
  stop(): Promise<void>;
}
export interface HistoryCoverage {
  ranges(guildId: string, channelId: string): { from: number; until: number }[];
  mark(guildId: string, channelId: string, from: number, until: number): void;
}
