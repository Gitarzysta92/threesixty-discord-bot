import type { Destination, DestinationStore } from '../contracts/destination.js';

/** Serialize configuration changes with delivery, so an acknowledged change has no old-channel sends still running. */
export class DestinationController {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: DestinationStore) {}
  private exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  read() { return this.store.get(); }
  configure(channelId: string | null, now = Date.now()) {
    return this.exclusive(() => {
      if (this.store.get()?.channelId !== channelId) this.store.set(channelId, now);
    });
  }
  deliver(operation: (destination: Destination) => Promise<void>) {
    return this.exclusive(async () => {
      const destination = this.store.get();
      if (destination) await operation(destination);
    });
  }
  async drain() { await this.pending; }
}
