// TrueType `name` 표 읽기(OFL 예약 글꼴 이름 확인용, 외부 의존성 없음).

/** @returns {{ nameID: number, platformID: number, value: string }[]} */
export function readNameRecords(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numTables = view.getUint16(4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(...buf.subarray(rec, rec + 4));
    if (tag === 'name') nameOffset = view.getUint32(rec + 8);
  }
  if (nameOffset < 0) throw new Error('name 표 없음');
  const count = view.getUint16(nameOffset + 2);
  const stringOffset = nameOffset + view.getUint16(nameOffset + 4);
  const records = [];
  for (let i = 0; i < count; i++) {
    const r = nameOffset + 6 + i * 12;
    const platformID = view.getUint16(r);
    const nameID = view.getUint16(r + 6);
    const length = view.getUint16(r + 8);
    const offset = view.getUint16(r + 10);
    const raw = buf.subarray(stringOffset + offset, stringOffset + offset + length);
    let value;
    if (platformID === 0 || platformID === 3) {
      value = '';
      for (let k = 0; k + 1 < raw.length; k += 2)
        value += String.fromCharCode((raw[k] << 8) | raw[k + 1]);
    } else {
      value = String.fromCharCode(...raw);
    }
    records.push({ nameID, platformID, value });
  }
  return records;
}

/** 글꼴 이름 계열 항목(1 패밀리, 3 고유 ID, 4 전체 이름, 6 PostScript, 16·17 타이포 패밀리·서브패밀리). */
export const FONT_NAME_IDS = [1, 3, 4, 6, 16, 17];

/** 예약 이름을 글꼴 이름 항목에서 쓰는 레코드(저작권 고지 항목 0 은 원문 유지 대상이라 제외). */
export function findReservedNameUse(buf, reserved) {
  return readNameRecords(buf).filter(
    (r) => FONT_NAME_IDS.includes(r.nameID) && r.value.includes(reserved),
  );
}
