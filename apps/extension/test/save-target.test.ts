import { describe, expect, it, vi } from 'vitest';
import {
  sanitizeFileName,
  SaveTarget,
  type SaveEnv,
  type WritableFileHandle,
} from '../src/viewer/save-target.js';

const BYTES = async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function fakeHandle(name = 'out.pdf', permission: PermissionState = 'granted') {
  const writes: number[] = [];
  const handle: WritableFileHandle & { writes: number[] } = {
    name,
    writes,
    createWritable: vi.fn(async () => ({
      write: async (d: Uint8Array) => {
        writes.push(d.byteLength);
      },
      close: async () => {},
    })),
    queryPermission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => permission),
  };
  return handle;
}

function domError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

function env(overrides: Partial<SaveEnv> = {}): SaveEnv & { revoked: string[] } {
  const revoked: string[] = [];
  return {
    downloads: { download: vi.fn(async () => 42) },
    createObjectURL: () => 'blob:x',
    revokeObjectURL: (u) => revoked.push(u),
    later: (fn) => fn(),
    now: () => 0,
    revoked,
    ...overrides,
  };
}

describe('SaveTarget', () => {
  it('first save uses the FSA picker; Ctrl+S re-save overwrites the same handle', async () => {
    const handle = fakeHandle('report-edited.pdf');
    const picker = vi.fn(async () => handle);
    const e = env({ showSaveFilePicker: picker });
    const t = new SaveTarget(e);

    const first = await t.save(BYTES, 'report.pdf');
    expect(first.bytes).toBe(4);
    expect(first).toMatchObject({ channel: 'fsa', status: 'saved', reusedHandle: false });
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'report.pdf' }));

    const second = await t.save(BYTES, 'report.pdf');
    expect(second).toMatchObject({
      channel: 'fsa',
      status: 'saved',
      reusedHandle: true,
      fileName: 'report-edited.pdf',
    });
    expect(picker).toHaveBeenCalledTimes(1);
    expect(handle.writes).toEqual([4, 4]);
    expect(e.downloads!.download).not.toHaveBeenCalled();
  });

  it('a cross-origin subframe (SecurityError) falls back to downloads (saveAs)', async () => {
    const e = env({
      showSaveFilePicker: async () => {
        throw domError(
          'SecurityError',
          "Cross origin sub frames aren't allowed to show a file picker.",
        );
      },
    });
    const r = await new SaveTarget(e).saveAs(BYTES, 'a.pdf');
    expect(r).toMatchObject({ channel: 'downloads', status: 'saved', downloadId: 42 });
    expect(r.fsaError).toMatch(/^SecurityError/);
    expect(e.downloads!.download).toHaveBeenCalledWith({
      url: 'blob:x',
      filename: 'a.pdf',
      saveAs: true,
      conflictAction: 'uniquify',
    });
    expect(e.revoked).toEqual(['blob:x']);
  });

  it('a user cancel (AbortError) does not fall back', async () => {
    const e = env({
      showSaveFilePicker: async () => {
        throw domError('AbortError');
      },
    });
    const r = await new SaveTarget(e).saveAs(BYTES, 'a.pdf');
    expect(r.status).toBe('cancelled');
    expect(e.downloads!.download).not.toHaveBeenCalled();
  });

  it('FSA unsupported → downloads; fails if downloads is also missing', async () => {
    const r1 = await new SaveTarget(env()).saveAs(BYTES, 'a');
    expect(r1).toMatchObject({
      channel: 'downloads',
      status: 'saved',
      fileName: 'a.pdf',
      errorCode: null,
    });
    const r2 = await new SaveTarget(env({ downloads: undefined })).saveAs(BYTES, 'a.pdf');
    expect(r2).toMatchObject({
      channel: 'downloads',
      status: 'failed',
      error: 'chrome.downloads 없음',
      errorCode: 'no-downloads',
    });
  });

  it('reports failure when permission is denied on re-save', async () => {
    const handle = fakeHandle('x.pdf', 'prompt');
    handle.requestPermission = vi.fn(async () => 'denied' as PermissionState);
    const t = new SaveTarget(env({ showSaveFilePicker: async () => handle }));
    await t.saveAs(BYTES, 'x.pdf');
    const r = await t.save(BYTES, 'x.pdf');
    expect(r).toMatchObject({
      channel: 'fsa',
      status: 'failed',
      reusedHandle: true,
      error: '쓰기 권한 denied',
      errorCode: 'write-permission-denied',
    });
    expect(handle.writes).toEqual([4]);
  });
});

describe('sanitizeFileName', () => {
  it('strips path and reserved characters, ensures the extension', () => {
    expect(sanitizeFileName('a/b\\c:d*.pdf')).toBe('a_b_c_d_.pdf');
    expect(sanitizeFileName('보고서')).toBe('보고서.pdf');
    expect(sanitizeFileName('  ')).toBe('document.pdf');
  });
});
