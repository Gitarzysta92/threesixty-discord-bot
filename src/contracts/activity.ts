/** Stable v1 integration boundary. No Discord or storage-library types. */
export interface MessageActivity {
  messageId: string;
  guildId: string;
  channelId: string;
  userId: string;
  occurredAt: number;
}
export interface ActivityWriter {
  record(event: MessageActivity): void;
  prune(before: number): void;
}
export interface ActivityReader {
  read(guildId: string, from: number, until: number): Iterable<MessageActivity>;
  collectionStartedAt(): number;
}
