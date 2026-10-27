// M5 C7: journal limit check RPC and re-export of the supported-size limit values (docs/m5-heap.md 5.3, sections 6 and 8, C7).
import { describe, expect, it } from 'vitest';
import {
  HEAP_WARN_FRACTION,
  SUPPORTED_INPUT_BYTES,
  WASM_HEAP_LIMIT_BYTES,
  createPdfWorkerApi,
  supportedInputBytes,
} from '../src/index.js';
import * as client from '../src/client.js';
import { editParagraph, harness } from './edit-harness.js';

describe('journalAdvice RPC(D4)', () => {
  it('the Worker RPC returns the journal check of the session as is, and the journal retention estimate grows with each commit', async () => {
    const { s } = harness();
    const api = createPdfWorkerApi(s);
    const before = await api.journalAdvice();
    expect(before).toEqual(s.journalAdvice());
    expect(before.advised).toBe(false);
    expect(before.journalBytes).toBe(0);
    expect(before.thresholdBytes).toBe(HEAP_WARN_FRACTION * WASM_HEAP_LIMIT_BYTES);
    await editParagraph(s, 1, 'journal rpc edit');
    const after = await api.journalAdvice();
    expect(after).toEqual(s.journalAdvice());
    expect(after.journalBytes).toBeGreaterThan(0);
    expect(after.advised).toBe(false);
    s.close();
  });

  it('throws when there is no document (the viewer only leaves a diagnostic log)', async () => {
    const { s } = harness();
    s.close();
    const api = createPdfWorkerApi(s);
    await expect(api.journalAdvice()).rejects.toThrow();
  });
});

describe('re-export of supported-size limit values (C7)', () => {
  it('core index and client (main thread) export the same values', () => {
    expect(SUPPORTED_INPUT_BYTES).toBe(supportedInputBytes('full'));
    expect(client.SUPPORTED_INPUT_BYTES).toBe(SUPPORTED_INPUT_BYTES);
    expect(client.HEAP_WARN_FRACTION).toBe(HEAP_WARN_FRACTION);
    expect(client.WASM_HEAP_LIMIT_BYTES).toBe(WASM_HEAP_LIMIT_BYTES);
    // docs/m5-heap.md section 6: full save 790 MiB.
    expect(Math.round(SUPPORTED_INPUT_BYTES / 2 ** 20)).toBe(790);
  });
});
