/**
 * Save target management (PLAN.md 5.3).
 * - First save: the user picks a target with FSA `showSaveFilePicker` and write permission is obtained.
 * - Re-save (Ctrl+S): overwrite the same handle. If permission was dropped, ask again.
 * - In contexts where FSA is unavailable (unsupported, cross-origin subframe SecurityError, etc.), save via `chrome.downloads`.
 *   This path always creates a new file and cannot re-save to the same target.
 * - If the user cancels the picker (AbortError), do not fall back.
 * - The picker and permission request need user activation (transient activation), so the bytes to save are received as a `BytesSource`
 *   after the picker is shown (prevents activation from expiring while a large save is pending).
 */

export type BytesSource = () => Promise<Uint8Array<ArrayBuffer>>;

export type SaveChannel = 'fsa' | 'downloads';

/** write-permission-denied: write permission refused on re-save (prompt, denied); no-downloads: chrome.downloads is unavailable. */
export type SaveErrorCode = 'write-permission-denied' | 'no-downloads';

export interface SaveOutcome {
  channel: SaveChannel;
  status: 'saved' | 'cancelled' | 'failed';
  fileName: string;
  /** Whether an existing FSA handle was used on re-save */
  reusedHandle: boolean;
  /** The error (`name: message`) when the FSA attempt failed and fell through to downloads */
  fsaError: string | null;
  /** Failure error (`name: message`, for diagnostics). */
  error: string | null;
  /** Cause code of a failure determined by this module (the caller builds the on-screen sentence, user decision 2026-10-26). null for other failures. */
  errorCode: SaveErrorCode | null;
  downloadId: number | null;
  bytes: number;
  ms: number;
}

type PermissionMode = { mode: 'readwrite' };

/** The part of the FSA handle used by this module. Includes permission methods missing from the TypeScript DOM lib. */
export interface WritableFileHandle {
  readonly name: string;
  createWritable(): Promise<{
    write(data: Uint8Array<ArrayBuffer>): Promise<void>;
    close(): Promise<void>;
  }>;
  queryPermission?(desc: PermissionMode): Promise<PermissionState>;
  requestPermission?(desc: PermissionMode): Promise<PermissionState>;
}

export interface SaveEnv {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<WritableFileHandle>;
  downloads?: {
    download(options: {
      url: string;
      filename: string;
      saveAs: boolean;
      conflictAction: 'uniquify';
    }): Promise<number>;
  };
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** Schedule blob URL release (must be released after the download has started). */
  later(fn: () => void): void;
  now(): number;
}

const errorText = (e: unknown) =>
  e instanceof Error || (typeof e === 'object' && e !== null && 'name' in e)
    ? `${(e as Error).name}: ${(e as Error).message}`
    : String(e);
const isAbort = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError';

/** Download file name: strip path separators and reserved characters, ensure .pdf. */
export function sanitizeFileName(name: string): string {
  const cleaned = [...name]
    .map((c) => (c.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(c) ? '_' : c))
    .join('');
  const base = cleaned.trim() || 'document.pdf';
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

export class SaveTarget {
  #handle: WritableFileHandle | null = null;

  constructor(private readonly env: SaveEnv) {}

  get handleName(): string | null {
    return this.#handle?.name ?? null;
  }

  /** Save As. FSA → downloads on failure. */
  async saveAs(source: BytesSource, suggestedName: string): Promise<SaveOutcome> {
    const t0 = this.env.now();
    const name = sanitizeFileName(suggestedName);
    if (!this.env.showSaveFilePicker) {
      return this.#download(source, name, 'showSaveFilePicker 없음', t0);
    }
    let handle: WritableFileHandle;
    try {
      handle = await this.env.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
    } catch (e) {
      if (isAbort(e))
        return this.#outcome(t0, { channel: 'fsa', status: 'cancelled', fileName: name });
      return this.#download(source, name, errorText(e), t0);
    }
    const base = { channel: 'fsa', fileName: handle.name } as const;
    try {
      const bytes = await source();
      await this.#write(handle, bytes);
      this.#handle = handle;
      return this.#outcome(t0, { ...base, status: 'saved', bytes: bytes.byteLength });
    } catch (e) {
      return this.#outcome(t0, { ...base, status: 'failed', error: errorText(e) });
    }
  }

  /** Save (Ctrl+S). If a handle was obtained, overwrite the same target; otherwise saveAs. */
  async save(source: BytesSource, suggestedName: string): Promise<SaveOutcome> {
    const handle = this.#handle;
    if (!handle) return this.saveAs(source, suggestedName);
    const t0 = this.env.now();
    const base = { channel: 'fsa', fileName: handle.name, reusedHandle: true } as const;
    try {
      const mode: PermissionMode = { mode: 'readwrite' };
      let state = (await handle.queryPermission?.(mode)) ?? 'granted';
      if (state !== 'granted') state = (await handle.requestPermission?.(mode)) ?? 'denied';
      if (state !== 'granted') {
        return this.#outcome(t0, {
          ...base,
          status: 'failed',
          error: `쓰기 권한 ${state}`,
          errorCode: 'write-permission-denied',
        });
      }
      const bytes = await source();
      await this.#write(handle, bytes);
      return this.#outcome(t0, { ...base, status: 'saved', bytes: bytes.byteLength });
    } catch (e) {
      return this.#outcome(t0, { ...base, status: 'failed', error: errorText(e) });
    }
  }

  /** For diagnostics: use the downloads path directly. */
  async saveViaDownloads(source: BytesSource, suggestedName: string): Promise<SaveOutcome> {
    return this.#download(source, sanitizeFileName(suggestedName), null, this.env.now());
  }

  async #write(handle: WritableFileHandle, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
  }

  async #download(
    source: BytesSource,
    name: string,
    fsaError: string | null,
    t0: number,
  ): Promise<SaveOutcome> {
    const base = { channel: 'downloads', fileName: name, fsaError } as const;
    const downloads = this.env.downloads;
    if (!downloads) {
      return this.#outcome(t0, {
        ...base,
        status: 'failed',
        error: 'chrome.downloads 없음',
        errorCode: 'no-downloads',
      });
    }
    let bytes = 0;
    let url: string | null = null;
    try {
      const data = await source();
      bytes = data.byteLength;
      url = this.env.createObjectURL(new Blob([data], { type: 'application/pdf' }));
      const downloadId = await downloads.download({
        url,
        filename: name,
        saveAs: true,
        conflictAction: 'uniquify',
      });
      return this.#outcome(t0, { ...base, status: 'saved', downloadId, bytes });
    } catch (e) {
      return this.#outcome(t0, { ...base, status: 'failed', error: errorText(e), bytes });
    } finally {
      const u = url;
      if (u) this.env.later(() => this.env.revokeObjectURL(u));
    }
  }

  #outcome(
    t0: number,
    o: Pick<SaveOutcome, 'channel' | 'status' | 'fileName'> & Partial<SaveOutcome>,
  ): SaveOutcome {
    return {
      reusedHandle: false,
      fsaError: null,
      error: null,
      errorCode: null,
      downloadId: null,
      bytes: 0,
      ...o,
      ms: this.env.now() - t0,
    };
  }
}
