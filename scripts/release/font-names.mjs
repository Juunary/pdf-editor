// Read the TrueType `name` table (for checking OFL reserved font names; no external dependencies).

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

/** Font-name family entries (1 family, 3 unique ID, 4 full name, 6 PostScript, 16·17 typographic family·subfamily). */
export const FONT_NAME_IDS = [1, 3, 4, 6, 16, 17];

/** Records that use the reserved name in font-name entries (copyright notice entry 0 is kept verbatim, so it is excluded). */
export function findReservedNameUse(buf, reserved) {
  return readNameRecords(buf).filter(
    (r) => FONT_NAME_IDS.includes(r.nameID) && r.value.includes(reserved),
  );
}
