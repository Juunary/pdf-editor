import type { PageModel } from '@pdf-editor/shared-types';

/**
 * Reading-text assembly (reference implementation of the rules in docs/m1-contract.md section 4; for tests and measurement).
 * In line order, join the `text` of the chars in each line, put one space at each `spaceAfter` position, "\n" between lines of the same block, "\n\n" between blocks.
 * Characters that belong to no line (`line` -1) are left out.
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

/** For comparing against the completion criterion: collapse runs of whitespace to one space and trim both ends. */
export function foldWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
