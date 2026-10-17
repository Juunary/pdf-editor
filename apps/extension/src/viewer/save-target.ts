/**
 * 저장 대상 관리(PLAN.md 5.3).
 * - 최초 저장: FSA `showSaveFilePicker` 로 사용자가 대상을 고르고 쓰기 권한을 확보한다.
 * - 재저장(Ctrl+S): 같은 핸들에 덮어쓴다. 권한이 풀렸으면 다시 요청한다.
 * - FSA 를 쓸 수 없는 문맥(미지원, 교차 출처 하위 프레임 SecurityError 등)은 `chrome.downloads` 로
 *   저장한다. 이 경로는 매번 새 파일이며 같은 대상 재저장이 되지 않는다.
 * - 사용자가 피커를 취소(AbortError)하면 폴백하지 않는다.
 * - 피커·권한 요청은 사용자 활성화(transient activation)가 필요하므로, 저장 바이트는 피커를
 *   띄운 뒤에 `BytesSource` 로 받는다(대용량 저장 대기 중 활성화 만료 방지).
 */

export type BytesSource = () => Promise<Uint8Array<ArrayBuffer>>;

export type SaveChannel = 'fsa' | 'downloads';

export interface SaveOutcome {
  channel: SaveChannel;
  status: 'saved' | 'cancelled' | 'failed';
  fileName: string;
  /** 재저장에서 기존 FSA 핸들을 썼는지 */
  reusedHandle: boolean;
  /** FSA 시도가 실패해 downloads 로 넘어간 경우 그 오류(`이름: 메시지`) */
  fsaError: string | null;
  error: string | null;
  downloadId: number | null;
  bytes: number;
  ms: number;
}

type PermissionMode = { mode: 'readwrite' };

/** FSA 핸들 중 이 모듈이 쓰는 부분. TypeScript DOM lib 에 없는 권한 메서드를 포함한다. */
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
  /** blob URL 해제 예약(다운로드가 시작된 뒤 해제해야 한다). */
  later(fn: () => void): void;
  now(): number;
}

const errorText = (e: unknown) =>
  e instanceof Error || (typeof e === 'object' && e !== null && 'name' in e)
    ? `${(e as Error).name}: ${(e as Error).message}`
    : String(e);
const isAbort = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError';

/** 다운로드 파일명: 경로 구분자·예약 문자 제거, .pdf 보장. */
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

  /** 다른 이름으로 저장. FSA → 실패 시 downloads. */
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

  /** 저장(Ctrl+S). 확보한 핸들이 있으면 같은 대상에 덮어쓰고, 없으면 saveAs. */
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
        return this.#outcome(t0, { ...base, status: 'failed', error: `쓰기 권한 ${state}` });
      }
      const bytes = await source();
      await this.#write(handle, bytes);
      return this.#outcome(t0, { ...base, status: 'saved', bytes: bytes.byteLength });
    } catch (e) {
      return this.#outcome(t0, { ...base, status: 'failed', error: errorText(e) });
    }
  }

  /** 진단용: downloads 경로를 직접 쓴다. */
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
      return this.#outcome(t0, { ...base, status: 'failed', error: 'chrome.downloads 없음' });
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
      downloadId: null,
      bytes: 0,
      ...o,
      ms: this.env.now() - t0,
    };
  }
}
