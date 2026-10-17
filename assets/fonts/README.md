# 폰트 자산

| 파일 | 원본 | 처리 | 크기 | sha256 | 라이선스 |
|---|---|---|---|---|---|
| `NotoSansKR-Regular-subset.ttf` | Google Fonts `ofl/notosanskr/NotoSansKR[wght].ttf` (10,414,588 B, sha256 `194018e6…e252`) | fontTools 4.62.1: `wght=400` 정적 인스턴스 → 서브셋(한글 음절 U+AC00–D7A3, 호환 자모, Basic Latin, Latin-1, 일반 구두점, CJK 기호, 전각) | 2,556,960 B, 12,267 글리프 | `079640421d15c92e710a2ac5cd4deb169b507823cc3a9f63b496d9c807bfbf02` | OFL-1.1 (`OFL.txt`) |

- 재생성: `scripts/fonts/build-noto-sans-kr-subset.sh` (원본 sha256 검사, `SOURCE_DATE_EPOCH` 고정으로 동일 해시 재현 확인 2026-10-18).
- `src/`(git 제외)에는 원본 가변 TTF 와 비교용 CFF OTF(notofonts `SubsetOTF/KR/NotoSansKR-Regular.otf`, 4,644,748 B)가 받아진다.
- glyf(TrueType) 를 쓰는 이유: CFF OTF 를 MuPDF 1.28.1 `addFont` 로 넣으면 재열기 렌더에서 한글 글리프가 깨지고 `subsetFonts()` 가 실패한다(`docs/m0-day1-log.md`).
