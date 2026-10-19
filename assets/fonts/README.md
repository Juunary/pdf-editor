# 폰트 자산

| 파일 | 원본 | 처리 | 크기 | sha256 | 라이선스 |
|---|---|---|---|---|---|
| `NotoSansKR-Regular-subset.ttf` | Google Fonts `ofl/notosanskr/NotoSansKR[wght].ttf` (10,414,588 B, sha256 `194018e6…e252`) | fontTools 4.62.1: `wght=400` 정적 인스턴스 → 서브셋(한글 음절 U+AC00–D7A3, 호환 자모, Basic Latin, Latin-1, 일반 구두점, €, ™, CJK 기호, 전각, KS X 1001 한자 4,888자 중 원본에 있는 4,885자) | 4,083,596 B, 16,968 글리프 | `08857b9f4cc1d3be92e83e91431d9836e14a5bb31d3e3ffe5928d32a4f04cb34` | OFL-1.1 (`OFL.txt`) |

- 재생성: `scripts/fonts/build-noto-sans-kr-subset.sh` (원본 sha256 검사, `SOURCE_DATE_EPOCH` 고정으로 동일 해시 재현 확인 2026-10-18, 한자·€·™ 추가 판 2026-10-19).
- 한자·€·™ 추가: `docs/m3-contract.md` D12(2026-10-19 사용자 결정). 이전 판은 2,556,960 B·12,267 글리프(sha256 `07964042…bf02`). 빠진 한자 3자(U+9699·U+F95F·U+F9AA)는 원본 폰트에 없다.
- `src/`(git 제외)에는 원본 가변 TTF 와 비교용 CFF OTF(notofonts `SubsetOTF/KR/NotoSansKR-Regular.otf`, 4,644,748 B)가 받아진다.
- glyf(TrueType) 를 쓰는 이유: CFF OTF 를 MuPDF 1.28.1 `addFont` 로 넣으면 재열기 렌더에서 한글 글리프가 깨지고 `subsetFonts()` 가 실패한다(`docs/m0-day1-log.md`).
