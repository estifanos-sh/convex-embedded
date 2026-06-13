import type { BroadcastChannelLike } from "./protocol";

export class Mailbox<T> {
  private closed = false;
  private readonly listen: boolean;
  private readonly listeners = new Set<(message: T) => void>();
  private readonly onMessage = (event: { data: unknown }) => {
    for (const listener of this.listeners) listener(event.data as T);
  };

  constructor(
    readonly name: string,
    private readonly channel: BroadcastChannelLike,
    options: { listen?: boolean } = {},
  ) {
    this.listen = options.listen ?? true;
    if (this.listen) this.channel.addEventListener("message", this.onMessage);
  }

  on(listener: (message: T) => void): () => void {
    if (!this.listen) {
      throw new Error(`Mailbox ${this.name} is send-only.`);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  send(message: T): void {
    if (!this.closed) this.channel.postMessage(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    if (this.listen) this.channel.removeEventListener("message", this.onMessage);
    this.channel.close();
  }
}
