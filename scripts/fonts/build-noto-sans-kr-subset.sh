#!/usr/bin/env bash
# Build the Noto Sans KR subset TTF (glyf).
#
# Result: assets/fonts/NotoSansKR-Regular-subset.ttf (committed to the repository, OFL-1.1)
# Source: Noto Sans KR variable TTF distributed by Google Fonts (wght 100–900, default instance 100)
# Processing: wght=400 static instance → subset of Hangul syllables·compatibility jamo·Latin·basic symbols·€·™ ranges + 4,888 KS X 1001 Hanja
#       (Hanja·€·™ added: docs/m3-contract.md D12, user decision 2026-10-19. One-to-one cmap: same contract amendment 2)
#
# The CFF-based OTF (notofonts SubsetOTF/KR) breaks the reopened render in the MuPDF 1.28.1 addFont path and
# subsetFonts() fails (docs/m0-day1-log.md). It is downloaded only for comparison.
#
# Requires: python3 (venv), curl. Network access.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/assets/fonts/src"
OUT="$ROOT/assets/fonts/NotoSansKR-Regular-subset.ttf"
VENV="${VENV:-$SRC/.venv}"
FONTTOOLS_VERSION=4.62.1
# Reproducible head.modified value
export SOURCE_DATE_EPOCH=1760745600

VF_URL='https://github.com/google/fonts/raw/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf'
VF_SHA256=194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252
OTF_URL='https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/KR/NotoSansKR-Regular.otf'
OTF_SHA256=69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68

UNICODES='U+0020-007E,U+00A0-00FF,U+2000-206F,U+20A9,U+20AC,U+2122,U+2190-21FF,U+2460-24FF,U+25A0-25FF,U+3000-303F,U+3130-318F,U+AC00-D7A3,U+FF00-FFEF'

fetch() { # url sha256 dest
  if [[ ! -f "$3" ]]; then curl -sSfL -o "$3" "$1"; fi
  local actual
  actual="$(sha256sum "$3" | cut -d' ' -f1)"
  if [[ "$actual" != "$2" ]]; then
    echo "sha256 불일치: $3 ($actual). 원본이 바뀌었으면 해시를 갱신하고 결과를 다시 검증할 것." >&2
    exit 1
  fi
}

mkdir -p "$SRC"
fetch "$VF_URL" "$VF_SHA256" "$SRC/NotoSansKR-VF.ttf"
fetch "$OTF_URL" "$OTF_SHA256" "$SRC/NotoSansKR-Regular.otf"

if [[ ! -x "$VENV/bin/fonttools" ]]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q "fonttools==$FONTTOOLS_VERSION"
fi

"$VENV/bin/fonttools" varLib.instancer "$SRC/NotoSansKR-VF.ttf" wght=400 --static \
  --update-name-table -q -o "$SRC/NotoSansKR-Regular-static.ttf"
# Code point list: the ranges above + the KS X 1001 Hanja (4,888 characters decoded from EUC-KR 0xCAA1–0xFDFE) that are in the source cmap.
# Make the cmap one-to-one (docs/m3-contract.md amendment 2): if several code points share one glyph, MuPDF addFont's
# ToUnicode picks the largest code point and changes extraction results (space → U+00A0, unified Hanja → compatibility Hanja, etc.).
# Code points removed: compatibility Hanja U+F900–FAFF (NFC maps them to unified Hanja), halfwidth jamo U+FFA0–FFDC, the losers in PREFER below.
"$VENV/bin/python" -I - "$SRC/NotoSansKR-Regular-static.ttf" "$UNICODES" > "$SRC/unicodes.txt" <<'PY'
import sys
from collections import defaultdict
from fontTools.ttLib import TTFont

font_path, ranges = sys.argv[1], sys.argv[2]
want = set()
for part in ranges.split(','):
    lo, _, hi = part.removeprefix('U+').partition('-')
    want.update(range(int(lo, 16), int(hi.removeprefix('U+') or lo, 16) + 1))
hanja = set()
for b1 in range(0xCA, 0xFE):
    for b2 in range(0xA1, 0xFF):
        try:
            hanja.add(ord(bytes([b1, b2]).decode('euc-kr')))
        except UnicodeDecodeError:
            pass
assert len(hanja) == 4888, len(hanja)
want |= hanja
cmap = TTFont(font_path).getBestCmap()
cps = sorted(c for c in want if c in cmap and not (0xF900 <= c <= 0xFAFF or 0xFFA0 <= c <= 0xFFDC))
# Code point to keep from the remaining groups that share the same glyph (by input frequency).
PREFER = {0x0020, 0x002D, 0x3000, 0x2013, 0x2035, 0xFF5E}
by_glyph = defaultdict(list)
for c in cps:
    by_glyph[cmap[c]].append(c)
keep = []
for group in by_glyph.values():
    if len(group) == 1:
        keep.append(group[0])
        continue
    chosen = [c for c in group if c in PREFER]
    assert len(chosen) == 1, [hex(c) for c in group]
    keep.append(chosen[0])
sys.stdout.write('\n'.join(f'U+{c:04X}' for c in sorted(keep)) + '\n')
PY

"$VENV/bin/pyftsubset" "$SRC/NotoSansKR-Regular-static.ttf" --unicodes-file="$SRC/unicodes.txt" \
  --layout-features='*' --output-file="$OUT"

# one-to-one check
"$VENV/bin/python" -I -c '
import sys
from fontTools.ttLib import TTFont
cmap = TTFont(sys.argv[1]).getBestCmap()
assert len(set(cmap.values())) == len(cmap), "cmap 이 일대일이 아님"
print("cmap", len(cmap), "일대일")
' "$OUT"

ls -l "$OUT"
sha256sum "$OUT"
