/**
 * 테스트 전용: 계약 3.1 core 판정("첫 등장 계수", 확정 2026-10-19, 수정 4 키 규칙)을 그대로 구현한다.
 *
 * 0) gid −1 보조 글리프는 대상 아님(호출자가 거른다).
 * 1) 직전 텍스트 콜백과 포인터가 같은 fillText·strokeText 는 통째로 건너뛴다.
 * 2) fillText·strokeText: 글리프마다 센다. 키(폰트, gid, trm 6값, 콜백 ctm 6값)를 센 목록에 넣는다(항목 목록).
 * 3) clipText·clipStrokeText·ignoreText: 키가 센 목록의 미소비 항목과 같으면 항목 하나를 소비하고 세지 않는다.
 *    아니면 센다. clipText·clipStrokeText 에서 새로 센 글리프는 센 목록에 넣는다(콜백 처리 후).
 * 4) 1개 이상 소비한 콜백이 끝나면 센 목록을 비운다.
 * 5) beginMask~endMask 사이 콜백은 호출하지 않는다(호출자 책임).
 */
export type TextCallbackKind = 'fill' | 'stroke' | 'clip' | 'clip-stroke' | 'ignore';

export interface JudgeOptions {
  /**
   * 1단계를 텍스트 콜백 종류와 무관하게 적용한다(수정 제안, docs/m1-pdf-ops.md 4절).
   * 확정 규칙(false)은 fillText·strokeText 만 건너뛴다.
   */
  skipSamePointerAllKinds?: boolean;
}

export class FirstArrivalJudge {
  private readonly counted = new Map<string, number>();
  private lastPointer: number | null = null;

  constructor(private readonly options: JudgeOptions = {}) {}

  /** 콜백 1개의 글리프별 판정. null = 콜백 전체 건너뜀(1단계). true = 새 글리프(센다), false = 재전송. */
  judge(kind: TextCallbackKind, pointer: number, keys: readonly string[]): boolean[] | null {
    const same = pointer === this.lastPointer;
    this.lastPointer = pointer;
    if (same && (this.options.skipSamePointerAllKinds || kind === 'fill' || kind === 'stroke')) {
      return null;
    }
    if (kind === 'fill' || kind === 'stroke') {
      for (const k of keys) this.counted.set(k, (this.counted.get(k) ?? 0) + 1);
      return keys.map(() => true);
    }
    let consumed = 0;
    const added: string[] = [];
    const out = keys.map((k) => {
      const n = this.counted.get(k) ?? 0;
      if (n > 0) {
        this.counted.set(k, n - 1);
        consumed++;
        return false;
      }
      if (kind !== 'ignore') added.push(k);
      return true;
    });
    for (const k of added) this.counted.set(k, (this.counted.get(k) ?? 0) + 1);
    if (consumed > 0) this.counted.clear();
    return out;
  }
}

export const glyphKey = (
  fontPointer: number,
  gid: number,
  trm: readonly number[],
  ctm: readonly number[],
) => `${fontPointer}:${gid}:${trm.join(',')}:${ctm.join(',')}`;
