/**
 * A typed multi-listener emitter whose `on` returns its own unsubscribe.
 *
 * Returning the unsubscribe rather than requiring a matching `off` is what
 * makes teardown reliable in a consumer that registers listeners inline.
 */
export class Emitter<Events extends { [K in keyof Events]: (...args: never[]) => void }> {
  private readonly listeners = new Map<keyof Events, Set<(...args: never[]) => void>>();

  on<K extends keyof Events>(event: K, listener: Events[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: Events[K]): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copied so a listener that unsubscribes itself does not mutate the set
    // that is being iterated.
    for (const listener of [...set]) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (error) {
        // A throwing listener must not stop the others or the emitting path.
        console.error('webterm: listener threw', error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
