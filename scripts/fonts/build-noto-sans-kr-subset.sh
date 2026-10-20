#!/usr/bin/env bash
# Noto Sans KR 서브셋 TTF(glyf) 생성.
#
# 결과: assets/fonts/NotoSansKR-Regular-subset.ttf (저장소에 커밋, OFL-1.1)
# 원본: Google Fonts 배포 Noto Sans KR 가변 TTF(wght 100–900, 기본 인스턴스 100)
# 처리: wght=400 정적 인스턴스 → 한글 음절·호환 자모·라틴·기본 기호·€·™ 범위 + KS X 1001 한자 4,888자 서브셋
#       (한자·€·™ 추가: docs/m3-contract.md D12, 2026-10-19 사용자 결정. cmap 일대일: 같은 계약 수정 2)
#
# CFF 기반 OTF(notofonts SubsetOTF/KR)는 MuPDF 1.28.1 addFont 경로에서 재열기 렌더가 깨지고
# subsetFonts() 가 실패한다(docs/m0-day1-log.md). 비교용으로만 함께 받는다.
#
# 필요: python3(venv), curl. 네트워크 접근.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/assets/fonts/src"
OUT="$ROOT/assets/fonts/NotoSansKR-Regular-subset.ttf"
VENV="${VENV:-$SRC/.venv}"
FONTTOOLS_VERSION=4.62.1
# 재현 가능한 head.modified 값
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
# 코드 포인트 목록: 위 범위 + KS X 1001 한자(EUC-KR 0xCAA1–0xFDFE 디코드 4,888자) 중 원본 cmap 에 있는 것.
# cmap 을 일대일로 만든다(docs/m3-contract.md 수정 2): 한 글리프를 여러 코드 포인트가 공유하면 MuPDF addFont 의
# ToUnicode 가 가장 큰 코드 포인트를 골라 추출 결과가 바뀐다(공백 → U+00A0, 통합 한자 → 호환 한자 등).
# 빼는 코드 포인트: 호환 한자 U+F900–FAFF(NFC 가 통합 한자로 바꿈), 반각 자모 U+FFA0–FFDC, 아래 PREFER 의 패자.
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
# 같은 글리프를 공유하는 나머지 묶음에서 남길 코드 포인트(입력 빈도 기준).
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

# 일대일 확인
"$VENV/bin/python" -I -c '
import sys
from fontTools.ttLib import TTFont
cmap = TTFont(sys.argv[1]).getBestCmap()
assert len(set(cmap.values())) == len(cmap), "cmap 이 일대일이 아님"
print("cmap", len(cmap), "일대일")
' "$OUT"

ls -l "$OUT"
sha256sum "$OUT"
