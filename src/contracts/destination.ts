export interface Destination {
  channelId: string;
  enabledAt: number;
}
/** One independently configurable destination per module and company server. */
export interface DestinationStore {
  get(): Destination | null;
  set(channelId: string | null, now: number): void;
}
