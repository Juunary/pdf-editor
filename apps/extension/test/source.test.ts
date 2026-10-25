import { describe, expect, it, vi } from 'vitest';
import { resolveViewerSource, type SourceEnv } from '../src/viewer/source.js';

const VIEWER = 'chrome-extension://id/viewer.html';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer; // "%PDF"

function streamInfo(embedded: boolean): chrome.mimeHandler.StreamInfo {
  return {
    embedded,
    mimeType: 'application/pdf',
    originalUrl: 'https://example.com/report.pdf',
    responseHeaders: {},
    streamUrl: 'blob:chrome-extension://id/stream-1',
    tabId: 7,
  };
}

function env(overrides: Partial<SourceEnv>): SourceEnv {
  return {
    href: VIEWER,
    mimeHandler: undefined,
    fetch: vi.fn(async () => new Response(PDF.slice(0))) as unknown as typeof fetch,
    now: () => 0,
    ...overrides,
  };
}

describe('resolveViewerSource', () => {
  it.each([
    [false, 'mime-handler-top'],
    [true, 'mime-handler-embedded'],
  ] as const)('MIME handler(embedded=%s): streamUrl 만 1회 fetch', async (embedded, kind) => {
    const e = env({ mimeHandler: { getStreamInfo: async () => streamInfo(embedded) } });
    const src = await resolveViewerSource(e);
    expect(src.kind).toBe(kind);
    expect(src.displayUrl).toBe('https://example.com/report.pdf');
    expect(src.bytes?.byteLength).toBe(4);
    expect(e.fetch).toHaveBeenCalledTimes(1);
    expect(e.fetch).toHaveBeenCalledWith('blob:chrome-extension://id/stream-1', undefined);
  });

  it('getStreamInfo 실패 + ?file= → url-param, 쿠키 포함 요청', async () => {
    const e = env({
      href: `${VIEWER}?file=https://example.com/x.pdf?a=1&b=2`,
      mimeHandler: {
        getStreamInfo: async () => {
          throw new Error('not a mime handler context');
        },
      },
    });
    const src = await resolveViewerSource(e);
    expect(src.kind).toBe('url-param');
    expect(e.fetch).toHaveBeenCalledWith('https://example.com/x.pdf?a=1&b=2', {
      credentials: 'include',
    });
  });

  it('원천이 없으면 viewer-page, fetch 없음', async () => {
    const e = env({});
    const src = await resolveViewerSource(e);
    expect(src.kind).toBe('viewer-page');
    expect(src.bytes).toBeNull();
    expect(e.fetch).not.toHaveBeenCalled();
  });

  it('onContext: 문맥을 정한 직후, 바이트를 받기 전에 부른다(머리 영역 확대 보정용)', async () => {
    const seen: string[] = [];
    const fetchSpy = vi.fn(async () => {
      seen.push('fetch');
      return new Response(PDF.slice(0));
    }) as unknown as typeof fetch;
    const onContext = vi.fn((kind: string, info: chrome.mimeHandler.StreamInfo | null) => {
      seen.push(`${kind}:${info?.tabId ?? '-'}`);
    });
    await resolveViewerSource(
      env({
        mimeHandler: { getStreamInfo: async () => streamInfo(false) },
        fetch: fetchSpy,
        onContext,
      }),
    );
    expect(seen).toEqual(['mime-handler-top:7', 'fetch']);
    seen.length = 0;
    await resolveViewerSource(
      env({ href: `${VIEWER}?file=https://example.com/x.pdf`, fetch: fetchSpy, onContext }),
    );
    expect(seen).toEqual(['url-param:-', 'fetch']);
    seen.length = 0;
    await resolveViewerSource(env({ onContext }));
    expect(seen).toEqual(['viewer-page:-']);
  });

  it('HTTP 오류는 예외', async () => {
    const e = env({
      href: `${VIEWER}?file=https://example.com/missing.pdf`,
      fetch: vi.fn(async () => new Response('x', { status: 404 })) as unknown as typeof fetch,
    });
    await expect(resolveViewerSource(e)).rejects.toThrow('HTTP 404');
    await expect(resolveViewerSource(e)).rejects.toMatchObject({
      name: 'PdfRequestError',
      status: 404,
    });
  });
});
