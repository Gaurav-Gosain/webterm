import type { Terminal } from '@xterm/xterm';
import type { ClipboardEvent, ClipboardOptions } from './types.js';

export type ClipboardStrategy = 'async-api' | 'exec-command' | 'custom' | 'none';

/**
 * Pick the write strategy for the current document.
 *
 * The async Clipboard API is the preferred path but exists only in secure
 * contexts, so a LAN IP or an http reverse proxy has no navigator.clipboard at
 * all. A hidden textarea and execCommand covers those; when neither is present
 * there is nothing left to try.
 *
 * Split out from the writer so it can be tested without a document.
 */
export function selectStrategy(env: {
  hasAsyncClipboard: boolean;
  hasExecCommand: boolean;
  hasCustomWriter?: boolean;
}): ClipboardStrategy {
  if (env.hasCustomWriter) return 'custom';
  if (env.hasAsyncClipboard) return 'async-api';
  if (env.hasExecCommand) return 'exec-command';
  return 'none';
}

/**
 * Copy text using a layered strategy, with a retry bound to the next user
 * gesture when a write is refused for want of one.
 */
export class Clipboard {
  private pending: string | null = null;
  private gestureBound = false;
  private readonly custom?: (text: string) => void | Promise<void>;
  private readonly onResult: (event: ClipboardEvent) => void;

  constructor(
    options: Pick<ClipboardOptions, 'write'> = {},
    onResult: (event: ClipboardEvent) => void = () => {},
  ) {
    this.custom = options.write;
    this.onResult = onResult;
  }

  strategy(): ClipboardStrategy {
    return selectStrategy({
      hasAsyncClipboard: typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText,
      hasExecCommand: typeof document !== 'undefined' && typeof document.execCommand === 'function',
      hasCustomWriter: !!this.custom,
    });
  }

  write(text: string): void {
    switch (this.strategy()) {
      case 'custom': {
        void Promise.resolve(this.custom!(text)).then(
          () => this.onResult({ text, written: true }),
          () => this.onResult({ text, written: false }),
        );
        return;
      }
      case 'async-api': {
        navigator.clipboard.writeText(text).then(
          () => this.onResult({ text, written: true }),
          () => {
            // Most often a refusal for want of a user gesture, which the next
            // pointerdown or keydown satisfies.
            this.deferToGesture(text);
          },
        );
        return;
      }
      case 'exec-command': {
        if (this.execCopy(text)) {
          this.onResult({ text, written: true });
          return;
        }
        this.deferToGesture(text);
        return;
      }
      default:
        this.onResult({ text, written: false });
    }
  }

  private execCopy(text: string): boolean {
    if (typeof document.execCommand !== 'function') return false;
    const active = document.activeElement as HTMLElement | null;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    Object.assign(ta.style, {
      position: 'fixed',
      left: '-9999px',
      top: '0',
      width: '1px',
      height: '1px',
      opacity: '0',
    });
    (document.body || document.documentElement).appendChild(ta);
    let ok = false;
    try {
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    if (active && typeof active.focus === 'function') active.focus();
    return ok;
  }

  private deferToGesture(text: string): void {
    this.pending = text;
    if (this.gestureBound) return;
    this.gestureBound = true;
    const flush = () => {
      const queued = this.pending;
      this.pending = null;
      this.gestureBound = false;
      window.removeEventListener('pointerdown', flush, true);
      window.removeEventListener('keydown', flush, true);
      if (queued == null) return;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(queued).then(
          () => this.onResult({ text: queued, written: true }),
          () => this.onResult({ text: queued, written: this.execCopy(queued) }),
        );
      } else {
        this.onResult({ text: queued, written: this.execCopy(queued) });
      }
    };
    this.gestureFlush = flush;
    window.addEventListener('pointerdown', flush, true);
    window.addEventListener('keydown', flush, true);
  }

  private gestureFlush?: () => void;

  dispose(): void {
    if (this.gestureFlush) {
      window.removeEventListener('pointerdown', this.gestureFlush, true);
      window.removeEventListener('keydown', this.gestureFlush, true);
      this.gestureFlush = undefined;
    }
    this.pending = null;
    this.gestureBound = false;
  }
}

/**
 * Decode an OSC 52 payload.
 *
 * atob yields one JavaScript char per byte and those bytes are UTF-8, so the
 * payload is fed through TextDecoder rather than used as a Latin-1 string.
 * Everything outside Latin-1 mojibakes otherwise.
 */
export function decodeOsc52(payload: string): string {
  const binary = atob(payload);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Build an OSC 52 response for a read request. UTF-8 encoded, then base64. */
export function encodeOsc52(targets: string, text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `\x1b]52;${targets};${btoa(binary)}\x1b\\`;
}

/**
 * Split an OSC 52 sequence body into its target list and payload. Returns
 * undefined for a body with no separator, which is malformed.
 */
export function parseOsc52(body: string): { targets: string; payload: string } | undefined {
  const sep = body.indexOf(';');
  if (sep < 0) return undefined;
  return { targets: body.slice(0, sep), payload: body.slice(sep + 1) };
}

/**
 * Register the OSC 52 handler. xterm.js registers none by default, so apps that
 * emit `ESC ] 52 ; c ; <base64> BEL` to copy (tmux, vim, bubbletea's
 * tea.SetClipboard) are otherwise ignored.
 */
export function registerOsc52(
  term: Terminal,
  clipboard: Clipboard,
  options: { read: boolean; reply?: (text: string) => void },
): { dispose(): void } | undefined {
  try {
    const handler = term.parser.registerOscHandler(52, (body: string) => {
      const parsed = parseOsc52(body);
      if (!parsed) return false;
      const { targets, payload } = parsed;
      // "?" is a read request. Answering it echoes the user's system clipboard
      // back to the remote, so it is swallowed unless the consumer opted in.
      if (payload === '?') {
        if (options.read && options.reply && navigator.clipboard?.readText) {
          void navigator.clipboard.readText().then(
            (text) => options.reply!(encodeOsc52(targets, text)),
            () => {},
          );
        }
        return true;
      }
      // An empty payload is the spec's clear form.
      if (payload === '') {
        clipboard.write('');
        return true;
      }
      try {
        clipboard.write(decodeOsc52(payload));
      } catch (error) {
        console.warn('webterm: OSC 52 decode failed', error);
      }
      return true;
    });
    return handler;
  } catch (error) {
    console.warn('webterm: OSC 52 handler registration failed', error);
    return undefined;
  }
}

/**
 * Copy-on-select. xterm owns the selection made by a plain left-drag; what it
 * does not own is the native browser selection produced by Shift+drag while an
 * application holds mouse tracking. Both are covered on mouseup, and the
 * enabled flag is read live so a toggle takes effect without rebinding.
 */
export function installCopyOnSelect(
  term: Terminal,
  container: HTMLElement,
  clipboard: Clipboard,
  enabled: () => boolean,
): () => void {
  const onMouseUp = () => {
    if (!enabled()) return;
    const termText = term.getSelection();
    if (termText) {
      clipboard.write(termText);
      return;
    }
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString();
    if (!text) return;
    if (sel.anchorNode && !container.contains(sel.anchorNode)) return;
    clipboard.write(text);
  };
  document.addEventListener('mouseup', onMouseUp);
  return () => document.removeEventListener('mouseup', onMouseUp);
}
