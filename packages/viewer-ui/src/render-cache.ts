/**
 * 쪽 렌더 결과 LRU 캐시(M5 계약 4.1). 키는 (쪽, 렌더 배율). 상한은 8쪽과 64 MiB 중 작은 쪽이다.
 * 문서가 바뀌면 해당 쪽의 항목을 모든 배율에서 버린다. 비트맵 하나가 상한보다 크면 담지 않는다.
 */
import type { RenderedPage } from '@pdf-editor/shared-types';

export const RENDER_CACHE_MAX_PAGES = 8;
export const RENDER_CACHE_MAX_BYTES = 64 * 2 ** 20;

export interface RenderCacheLimits {
  maxPages: number;
  maxBytes: number;
}

export class RenderCache {
  /** Map 의 삽입 순서가 최근 사용 순서다(맨 앞이 가장 오래됨). */
  private readonly entries = new Map<string, { pageIndex: number; value: RenderedPage }>();
  private bytes = 0;
  /** 무효화마다 올린다. 진행 중이던 렌더가 무효화 뒤에 도착하면 `put` 에서 거를 때 쓴다. */
  private epochValue = 0;

  constructor(
    private readonly limits: RenderCacheLimits = {
      maxPages: RENDER_CACHE_MAX_PAGES,
      maxBytes: RENDER_CACHE_MAX_BYTES,
    },
  ) {}

  static key(pageIndex: number, scale: number): string {
    return `${pageIndex}@${scale.toFixed(4)}`;
  }

  get epoch(): number {
    return this.epochValue;
  }

  get size(): number {
    return this.entries.size;
  }

  get byteSize(): number {
    return this.bytes;
  }

  has(pageIndex: number, scale: number): boolean {
    return this.entries.has(RenderCache.key(pageIndex, scale));
  }

  get(pageIndex: number, scale: number): RenderedPage | null {
    const key = RenderCache.key(pageIndex, scale);
    const hit = this.entries.get(key);
    if (!hit) return null;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  /** `epoch` 는 렌더를 시작할 때의 `cache.epoch`. 그 사이 무효화가 있었으면 담지 않는다. */
  put(
    pageIndex: number,
    scale: number,
    value: RenderedPage,
    epoch: number = this.epochValue,
  ): void {
    if (epoch !== this.epochValue || value.clip !== null) return;
    const size = value.rgba.byteLength;
    if (size > this.limits.maxBytes) return;
    const key = RenderCache.key(pageIndex, scale);
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.value.rgba.byteLength;
      this.entries.delete(key);
    }
    this.entries.set(key, { pageIndex, value });
    this.bytes += size;
    while (this.entries.size > this.limits.maxPages || this.bytes > this.limits.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.bytes -= this.entries.get(oldest.value)!.value.rgba.byteLength;
      this.entries.delete(oldest.value);
    }
  }

  /** 이 쪽들의 항목을 모든 배율에서 버린다. */
  invalidate(pages: readonly number[]): void {
    this.epochValue++;
    const set = new Set(pages);
    for (const [key, entry] of this.entries) {
      if (!set.has(entry.pageIndex)) continue;
      this.bytes -= entry.value.rgba.byteLength;
      this.entries.delete(key);
    }
  }

  clear(): void {
    this.epochValue++;
    this.entries.clear();
    this.bytes = 0;
  }
}
