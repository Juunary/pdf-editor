/**
 * Page render result LRU cache (M5 contract 4.1). The key is (page, render scale). The limit is the smaller of 8 pages and 64 MiB.
 * When the document changes, the entries of the affected pages are dropped at every scale. A bitmap larger than the limit is not stored.
 */
import type { RenderedPage } from '@pdf-editor/shared-types';

export const RENDER_CACHE_MAX_PAGES = 8;
export const RENDER_CACHE_MAX_BYTES = 64 * 2 ** 20;

export interface RenderCacheLimits {
  maxPages: number;
  maxBytes: number;
}

export class RenderCache {
  /** The insertion order of the Map is the recency order (the front is the oldest). */
  private readonly entries = new Map<string, { pageIndex: number; value: RenderedPage }>();
  private bytes = 0;
  /** Incremented on every invalidation. Used by `put` to filter out a render that was in flight and arrives after an invalidation. */
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

  /** `epoch` is the `cache.epoch` at the time the render started. If there was an invalidation in between, it is not stored. */
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

  /** Drops the entries of these pages at every scale. */
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
