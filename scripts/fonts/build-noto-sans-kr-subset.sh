#!/usr/bin/env bash
# Noto Sans KR 서브셋 TTF(glyf) 생성.
#
# 결과: assets/fonts/NotoSansKR-Regular-subset.ttf (저장소에 커밋, OFL-1.1)
# 원본: Google Fonts 배포 Noto Sans KR 가변 TTF(wght 100–900, 기본 인스턴스 100)
# 처리: wght=400 정적 인스턴스 → 한글 음절·호환 자모·라틴·기본 기호 범위 서브셋
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

UNICODES='U+0020-007E,U+00A0-00FF,U+2000-206F,U+20A9,U+2190-21FF,U+2460-24FF,U+25A0-25FF,U+3000-303F,U+3130-318F,U+AC00-D7A3,U+FF00-FFEF'

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
"$VENV/bin/pyftsubset" "$SRC/NotoSansKR-Regular-static.ttf" --unicodes="$UNICODES" \
  --layout-features='*' --output-file="$OUT"

ls -l "$OUT"
sha256sum "$OUT"
