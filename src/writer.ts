import type { Terminal } from '@xterm/xterm';

/**
 * Coalesces every chunk that arrives within one animation frame into a single
 * `term.write`.
 *
 * A remote that emits many small writes per frame otherwise pays xterm's
 * per-write parser entry and render scheduling for each one. The scratch buffer
 * is reused so the common multi-chunk case does not allocate.
 */
export class BatchedWriter {
  private pending: Uint8Array[] = [];
  private scheduled = false;
  private scratch = new Uint8Array(64 * 1024);
  // Whether xterm still holds the scratch. term.write does not copy and does
  // not parse before it returns: it queues the array and consumes it on a later
  // task, sliced across as many tasks as its frame budget needs. Writing into
  // the scratch again before that finishes rewrites bytes that are still queued,
  // and the terminal renders the wrong ones.
  private scratchBusy = false;
  private disposed = false;
  private frame = 0;
  private readonly term: Terminal;

  constructor(term: Terminal) {
    this.term = term;
  }

  write(data: Uint8Array | string): void {
    if (this.disposed) return;
    if (typeof data === 'string') {
      // Strings are handed to xterm directly: batching them would mean an
      // encode and a decode for no gain.
      this.term.write(data);
      return;
    }
    // Copied because the caller may own the underlying buffer, and a transport
    // that reuses one read buffer is normal.
    this.pending.push(new Uint8Array(data));
    if (this.scheduled) return;
    this.scheduled = true;
    this.frame = requestAnimationFrame(() => this.flushSync());
  }

  /** Write everything queued now. Safe to call with nothing pending. */
  flushSync(): void {
    this.scheduled = false;
    if (this.disposed || this.pending.length === 0) return;

    if (this.pending.length === 1) {
      this.term.write(this.pending[0]);
    } else {
      let total = 0;
      for (const chunk of this.pending) total += chunk.length;

      // The scratch is only borrowed back once the previous loan has been
      // parsed; a slow frame keeps it out and this batch allocates instead.
      const reuse = !this.scratchBusy && total <= this.scratch.length;
      const combined = reuse ? this.scratch.subarray(0, total) : new Uint8Array(total);
      let offset = 0;
      for (const chunk of this.pending) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      if (reuse) {
        this.scratchBusy = true;
        this.term.write(combined, () => {
          this.scratchBusy = false;
        });
      } else {
        this.term.write(combined);
      }
    }

    this.pending.length = 0;
  }

  /** Flush and resolve once the emulator has consumed everything written. */
  flush(): Promise<void> {
    this.flushSync();
    return new Promise((resolve) => this.term.write('', resolve));
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduled) cancelAnimationFrame(this.frame);
    this.scheduled = false;
    this.scratchBusy = false;
    this.pending.length = 0;
  }
}
