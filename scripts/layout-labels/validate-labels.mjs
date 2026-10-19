#!/usr/bin/env node
/**
 * 라벨 파일 형식·소속 검사(docs/m2-contract.md 4.1). 작업 묶음 TXT 로 줄 수·지문·보이는 줄을 확인한다.
 *   node scripts/layout-labels/validate-labels.mjs <라벨 디렉터리> <작업 묶음 디렉터리>
 */
import fs from 'node:fs';
import path from 'node:path';

const [labelsDir, packetsDir] = process.argv.slice(2);
const ROLES = new Set([
  'body',
  'heading',
  'list-item',
  'caption',
  'header',
  'footer',
  'footnote',
  'other',
]);
let failed = 0;
const files = fs
  .readdirSync(labelsDir, { recursive: true })
  .filter((f) => String(f).endsWith('.json'));
for (const rel of files.sort()) {
  const file = path.join(labelsDir, rel);
  const errs = [];
  let label;
  try {
    label = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`FAIL ${rel}: JSON ${e.message}`);
    failed++;
    continue;
  }
  const name = `${label.doc}-p${String(label.pageIndex).padStart(3, '0')}`;
  const txt = path.join(packetsDir, `${name}.txt`);
  if (!fs.existsSync(txt)) errs.push(`작업 묶음 없음 ${name}`);
  else {
    const lines = fs.readFileSync(txt, 'utf8').split('\n');
    const head = lines[0];
    const count = Number(/lineCount=(\d+)/.exec(head)?.[1]);
    const sha = /linesSha256=([0-9a-f]+)/.exec(head)?.[1];
    if (label.extract?.lineCount !== count)
      errs.push(`lineCount ${label.extract?.lineCount} != ${count}`);
    if (label.extract?.linesSha256 !== sha) errs.push('linesSha256 불일치');
    const visible = new Set();
    for (const l of lines.slice(3)) {
      const m = /^(\d+) \| [^|]+\| [^|]+\| [^|]+\| (.*)$/.exec(l);
      if (m && m[2].trim() !== '') visible.add(Number(m[1]));
    }
    const seen = new Map();
    const note = (i, where) => {
      if (!Number.isInteger(i) || i < 0 || i >= count) errs.push(`${where}: 줄 번호 범위 밖 ${i}`);
      seen.set(i, [...(seen.get(i) ?? []), where]);
    };
    if (!['dev', 'test'].includes(label.split)) errs.push(`split ${label.split}`);
    if (!['draft', 'reviewed', 'confirmed'].includes(label.status))
      errs.push(`status ${label.status}`);
    // 독립 검토: reviewed 이상은 검토자가 있어야 하고 라벨러와 달라야 한다.
    if (label.status !== 'draft') {
      if (!label.reviewedBy) errs.push('reviewedBy 없음');
      else if (label.reviewedBy === label.labeledBy) errs.push('reviewedBy 가 labeledBy 와 같음');
    }
    (label.items ?? []).forEach((it, k) => {
      if (it.type === 'paragraph') {
        if (!ROLES.has(it.role)) errs.push(`items[${k}] role ${it.role}`);
        if (!it.lines?.length) errs.push(`items[${k}] 빈 문단`);
        it.lines?.forEach((i) => note(i, `items[${k}]`));
      } else if (it.type === 'table') {
        if (!(it.rows >= 1 && it.cols >= 1)) errs.push(`items[${k}] rows/cols`);
        if (!Array.isArray(it.bbox) || it.bbox.length !== 4) errs.push(`items[${k}] bbox`);
        it.lines?.forEach((i) => note(i, `items[${k}]`));
        const slots = new Map();
        for (const c of it.cells ?? [])
          for (let r = c.row; r < c.row + (c.rowSpan ?? 1); r++)
            for (let q = c.col; q < c.col + (c.colSpan ?? 1); q++) {
              const key = `${r},${q}`;
              if (slots.has(key)) errs.push(`items[${k}] 셀 겹침 (${key})`);
              slots.set(key, true);
            }
        for (const c of it.cells ?? []) {
          for (const i of c.lines ?? [])
            if (!it.lines.includes(i)) errs.push(`items[${k}] 셀 줄 ${i} 이 표 lines 에 없음`);
          if (c.row + (c.rowSpan ?? 1) > it.rows || c.col + (c.colSpan ?? 1) > it.cols)
            errs.push(`items[${k}] 셀 범위 밖`);
        }
      } else if (it.type === 'figure') {
        if (!Array.isArray(it.bbox) || it.bbox.length !== 4) errs.push(`items[${k}] bbox`);
        it.labels?.forEach((i) => note(i, `items[${k}]`));
      } else errs.push(`items[${k}] type ${it.type}`);
    });
    (label.ignoreLines ?? []).forEach((i) => note(i, 'ignoreLines'));
    for (const [i, where] of seen)
      if (where.length > 1) errs.push(`줄 ${i} 중복: ${where.join(', ')}`);
    const missing = [...visible].filter((i) => !seen.has(i));
    if (missing.length) errs.push(`빠진 줄 ${missing.join(',')}`);
  }
  if (errs.length) {
    failed++;
    console.log(`FAIL ${rel}:\n  ${errs.join('\n  ')}`);
  } else console.log(`ok   ${rel} (${label.status}, ${label.split}, items=${label.items.length})`);
}
process.exit(failed ? 1 : 0);
