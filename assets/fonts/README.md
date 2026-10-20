# 폰트 자산

| 파일 | 원본 | 처리 | 크기 | sha256 | 라이선스 |
|---|---|---|---|---|---|
| `NotoSansKR-Regular-subset.ttf` | Google Fonts `ofl/notosanskr/NotoSansKR[wght].ttf` (10,414,588 B, sha256 `194018e6…e252`) | fontTools 4.62.1: `wght=400` 정적 인스턴스 → 서브셋(한글 음절 U+AC00–D7A3, 호환 자모, Basic Latin, Latin-1, 일반 구두점, €, ™, CJK 기호, 전각, KS X 1001 한자). cmap 일대일(한 글리프에 코드 포인트 하나) | 4,082,236 B, 16,966 글리프, cmap 16,567자 | `e96d7e433dfce68846113fcbaa0d7c3c69744a08465e0c89a7fd4f0205b9a287` | OFL-1.1 (`OFL.txt`) |

- 재생성: `scripts/fonts/build-noto-sans-kr-subset.sh` (원본 sha256 검사, `SOURCE_DATE_EPOCH` 고정으로 동일 해시 재현 확인 2026-10-18, 한자·€·™ 추가 판 2026-10-19).
- 한자·€·™ 추가: `docs/m3-contract.md` D12(2026-10-19 사용자 결정). 이전 판은 2,556,960 B·12,267 글리프(sha256 `07964042…bf02`). KS X 1001 한자 4,888자는 NFC 로 4,622자가 되고, 그중 4,619자를 포함한다. 빠진 3자(U+9699·U+90CE·U+96B8)는 원본 폰트에 없다.
- cmap 일대일(같은 계약 수정 2): 원본은 여러 코드 포인트가 한 글리프를 공유해, MuPDF `addFont` 의 ToUnicode 가 그중 가장 큰 코드 포인트를 골랐다(공백 → U+00A0, 통합 한자 → 호환 한자, 호환 자모 → 반각 자모). 그래서 호환 한자 U+F900–FAFF, 반각 자모 U+FFA0–FFDC, 그리고 U+00A0·U+00AD·U+2011·U+2003·U+2012·U+301C·U+FF40 을 뺐다. 2026-10-19 MuPDF 1.28.1 에서 공백류를 뺀 16,564 코드 포인트의 gid → 추출 왕복이 모두 일치했다.
- `src/`(git 제외)에는 원본 가변 TTF 와 비교용 CFF OTF(notofonts `SubsetOTF/KR/NotoSansKR-Regular.otf`, 4,644,748 B)가 받아진다.
- glyf(TrueType) 를 쓰는 이유: CFF OTF 를 MuPDF 1.28.1 `addFont` 로 넣으면 재열기 렌더에서 한글 글리프가 깨지고 `subsetFonts()` 가 실패한다(`docs/m0-day1-log.md`).
