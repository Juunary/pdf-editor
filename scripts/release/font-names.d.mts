export function readNameRecords(
  buf: Uint8Array,
): { nameID: number; platformID: number; value: string }[];
export const FONT_NAME_IDS: number[];
export function findReservedNameUse(
  buf: Uint8Array,
  reserved: string,
): { nameID: number; platformID: number; value: string }[];
