import type { PageModel } from '@pdf-editor/shared-types';

/**
 * 읽기 텍스트 조립(docs/m1-contract.md 4절 규칙의 참조 구현, 테스트·계측용).
 * 줄 순서 → 줄 안 chars 의 text 를 잇고 `spaceAfter` 위치에 공백 하나, 같은 블록 줄 사이 "\n", 블록 사이 "\n\n".
 * 줄에 속하지 않은 글자(`line` -1)는 넣지 않는다.
 */
export function assembleReadingText(model: PageModel): string {
  const blocks = model.blocks.map((block) =>
    block.lines
      .map((lineIndex) => {
        const line = model.lines[lineIndex]!;
        const spaces = new Set(line.spaceAfter);
        return line.chars
          .map((charIndex, k) => model.chars[charIndex]!.text + (spaces.has(k) ? ' ' : ''))
          .join('');
      })
      .join('\n'),
  );
  return blocks.join('\n\n');
}

/** 완료 기준 비교용: 연속 공백류를 공백 하나로 접고 앞뒤를 자른다. */
export function foldWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
