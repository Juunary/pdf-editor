// M5 C7: 저널 상한 판정 RPC·지원 크기 상한 값 재export(docs/m5-heap.md 5.3·6절·8절 C7).
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
  it('Worker RPC 는 세션의 저널 판정을 그대로 돌려주고, 커밋마다 저널 보유 추정이 늘어난다', async () => {
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

  it('문서가 없으면 예외로 알린다(뷰어는 진단 로그만 남긴다)', async () => {
    const { s } = harness();
    s.close();
    const api = createPdfWorkerApi(s);
    await expect(api.journalAdvice()).rejects.toThrow();
  });
});

describe('지원 크기 상한 값 재export(C7)', () => {
  it('core index 와 client(메인 스레드) 가 같은 값을 내보낸다', () => {
    expect(SUPPORTED_INPUT_BYTES).toBe(supportedInputBytes('full'));
    expect(client.SUPPORTED_INPUT_BYTES).toBe(SUPPORTED_INPUT_BYTES);
    expect(client.HEAP_WARN_FRACTION).toBe(HEAP_WARN_FRACTION);
    expect(client.WASM_HEAP_LIMIT_BYTES).toBe(WASM_HEAP_LIMIT_BYTES);
    // docs/m5-heap.md 6절: 전체 저장 790 MiB.
    expect(Math.round(SUPPORTED_INPUT_BYTES / 2 ** 20)).toBe(790);
  });
});
