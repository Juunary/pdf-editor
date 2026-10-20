# M3 reflow: 셰이퍼 · 문단 배치(5.4) · V6

> 2026-10-20 사용자 결정으로 초과 처리(축소·넓히기·그대로 3선택, `fontScale`)는 자동 확장·되돌리기로 바뀌었다(`docs/m3-contract.md` 수정 5, `docs/m3-integration.md` 9절). 이 문서의 해당 서술은 그 이전 기록이다.

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-19 |
| 브랜치 | `m3-reflow`(기준 `a7464f1`, 계약 수정 1·2 머지 `1b640dd`(m3 `64f6fcd`), worktree `/mnt/nas4/kjune/pdf-editor-m3-reflow`) |
| 범위 | `docs/m3-contract.md` 6.2 작업 S2: D5 셰이퍼, 5.4 리플로우 전부, V6 |
| 상태 | 계약 범위 구현 완료. V6 통과(계약 수정 2 폰트 기준): /W 차이 0, cmap gid 16,567개 일대일·ToUnicode 정확 왕복. 수정 2 이전 폰트의 왕복 불일치(316자)는 6절 N1 로 보고해 수정 2 로 해소 |
| 측정 환경 | 서버 `sailab01`(AMD Ryzen 9 5950X), Node 22.18.0, harfbuzzjs 1.6.2, npm `mupdf` 1.28.1, 번들 폴백 폰트 `assets/fonts/NotoSansKR-Regular-subset.ttf`(계약 수정 2 판 4,082,236 B, sha256 `e96d7e43…a287`. 4절 아래 표는 수정 2 이전 판 4,083,596 B 측정) |

## 1. 구현 범위

| 파일 | 내용 |
| --- | --- |
| `src/index.ts` | 계약 타입(변경 없음). `layoutParagraph` 본문 연결. 추가 내보내기: `isOverflowClipped`, `KINSOKU_HEAD`·`KINSOKU_TAIL`, `OPENTYPE_FEATURES_OFF` |
| `src/layout.ts` | 배치: 클러스터 생성 → 셰이핑 → 줄 나눔 → 초과 처리 → 정렬·좌표 → `ReflowSummary`·`WritableGlyph[][]` |
| `src/text.ts` | 클러스터 분할(`Intl.Segmenter` grapheme), 줄 나눔 분류·규칙, 금칙 표 |
| `src/shaper.ts` | 셰이퍼 인터페이스, pdf-widths 셰이퍼 |
| `src/opentype.ts` | harfbuzz 셰이퍼(kern 만), 폰트 캐시, cmap 검사·대체 |
| `src/clock.ts` | 경과 시간(빌드 lib 호환) |
| `test/linebreak.test.ts` | 줄 나눔 기회·비상 나눔·강제 줄바꿈·금칙 |
| `test/layout.test.ts` | 정렬·들여쓰기·기준선·영역 상한·초과·shrink·expand·keep·빈 텍스트·missing·클러스터·입력 검사·결정성 |
| `test/opentype.test.ts` | kern·줄 끝 커닝·합자 없음·언어 태그 없음·2바이트 코드·기본 무시 문자·폰트에 없는 글자·스크립트 혼합 |
| `test/v6.test.ts` | V6(MuPDF `addFont` 의 /W·ToUnicode, 배치 출력 왕복, MuPDF 추출 왕복) |
| `test/bench.test.ts` | 500자 문단 배치 시간 |

- 의존성·타입·`layoutParagraph` 시그니처 변경 없음. harfbuzzjs(dependency)·mupdf(devDependency, 시험 전용)는 계약 커밋 그대로다.
- `packages/reflow/test/contract.test.ts`(“M3 미구현” 예외 확인)는 구현으로 무의미해져 지웠다.

## 2. 배치 규칙(계약 5.4 구현)

### 2.1 영역·좌표

| 항목 | 구현 |
| --- | --- |
| 영역 | `format.area ∩ areaLimit`. 교집합이 비면 폭·높이 0(각 클러스터가 한 줄씩 놓인다) |
| 줄 폭 | 영역 가로. `firstLineIndent > 0` 이면 첫 줄 왼쪽을 그만큼 들이고 폭을 줄인다. 음수면 둘째 줄부터 왼쪽을 `|indent|` 만큼 들이고 폭을 줄인다. 들여쓰기는 배율 s 를 곱하지 않는다 |
| 기준선 | 줄 k 기준선 = 영역 위 + `firstBaselineOffset`·s + k·`lineHeight`·s. 줄 간격은 글자 크기와 관계없이 일정 |
| `lineHeight ≤ 0` | 방어값 = 가장 큰 구간 글자 크기 × 1.2(“원 문단이 한 줄이면 크기 × 1.2” 는 계약상 pdf-ops 계획 단계가 채운다) |
| 글자 크기 | 구간 `size` × s. 전진량 = 셰이퍼 결과(1/1000 em) × 크기 / 1000 |
| 좌표 | 페이지 공간 기준선 원점. `PlacedGlyph`·`WritableGlyph` 의 y 는 줄 기준선 |

### 2.2 클러스터

- 확장 자소(`Intl.Segmenter('und', { granularity: 'grapheme' })`). 구간(`FontSegment`) 경계에서도 나눈다(한 클러스터는 한 폰트).
- 분류는 클러스터 첫 코드 포인트로 한다. 강제 줄바꿈은 `\n`·`\r`·`\r\n`(한 클러스터)·U+000B·U+000C·U+0085·U+2028·U+2029.
- 같은 폰트 키가 이어지는 클러스터(강제 줄바꿈·missing 에서 끊김)를 한 번에 셰이핑한다. 구간이 달라도 폰트 키가 같으면 커닝이 이어진다.

### 2.3 줄 나눔 기회(클러스터 a 와 b 사이, 위에서부터 먼저 맞는 규칙)

| 순서 | 조건 | 결과 |
| --- | --- | --- |
| 1 | a 가 강제 줄바꿈 | 반드시 나눔 |
| 2 | b 가 공백·강제 줄바꿈 | 나누지 않음(공백은 앞 줄 끝에 매달림) |
| 3 | b 가 줄 머리 금지 | 나누지 않음 |
| 4 | a 앞쪽 마지막 비공백 클러스터가 줄 끝 금지(“( x” 포함) | 나누지 않음 |
| 5 | a 가 공백 또는 U+200B | 나눔 |
| 6 | a 또는 b 가 결합 문자(U+00A0·U+202F·U+2007·U+2011·U+2060·U+FEFF·곧은 따옴표 `"` `'`) | 나누지 않음 |
| 7 | a 가 하이픈·대시(U+002D·U+00AD·U+2010·U+2012–2015·U+2E3A·U+2E3B) | a 앞이 공백·문단 처음이 아니고 b 가 숫자(`\p{Nd}`)가 아니면 나눔(“co-op” 나눔, “2026-10”·“ -x” 안 나눔) |
| 8 | a·b 모두 CJK 표의문자류 | 나눔 |
| 9 | 그 밖(라틴 단어 안, 한글 어절 안, 한글–한자, 라틴–CJK) | 나누지 않음 |

- CJK 표의문자류: Han·Hiragana·Katakana·Bopomofo 스크립트, U+3000–303F, U+31F0–31FF, U+3200–33FF, U+FE30–FE4F, U+FF00–FF9F, U+FFE0–FFEF, Extended_Pictographic. 한글은 넣지 않는다(어절 우선, keep-all).
- 줄 폭 판정: 줄을 그 클러스터 뒤에서 끝낼 때의 폭(줄 끝 공백 제외, 마지막 클러스터의 다음 커닝 제외)이 줄 폭 + 0.01pt 를 넘으면 넘침. 0.01pt 는 원 문단 bbox 와 같은 폭의 줄이 부동소수 오차로 넘치지 않게 하는 여유다.
- 넘치면 그 줄의 마지막 일반 나눔 기회에서 나눈다(탐욕, 첫 맞춤). 줄 안에 일반 나눔 기회가 없으면(어절·라틴 단어가 줄 폭보다 김) 비상 나눔: 공백 앞이 아니고 금칙(3·4)과 결합 문자(6)를 지키는 가장 뒤 클러스터 경계, 없으면 넘친 클러스터 앞. 줄에는 최소 한 클러스터가 들어간다.
- 결과: 한글은 어절 우선 후 음절, 긴 라틴 단어는 글자 단위. 긴 어절은 먼저 다음 줄로 넘긴 뒤 나눈다(CSS `overflow-wrap: break-word` 와 같음).
- 줄 끝 공백과 그 뒤 강제 줄바꿈은 그 줄에 붙는다. 텍스트가 강제 줄바꿈으로 끝나면 뒤에 빈 줄 1개(캐럿용)를 더한다.

### 2.4 금칙 표(고정, `src/text.ts` 와 같음)

| 구분 | 글자 |
| --- | --- |
| 줄 머리 금지(이 글자 앞에서 나누지 않음) | `! % ) , . : ; ? ] }` |
| | `¢ ° · ’ ” ‰ ′ ″ › » … ‥ ℃` |
| | `、 。 〉 》 」 』 】 〕 〗 〙 〛 〟 ・ ー 々 〻 ゝ ゞ ヽ ヾ` |
| | `ぁ ぃ ぅ ぇ ぉ っ ゃ ゅ ょ ゎ ゕ ゖ ァ ィ ゥ ェ ォ ッ ャ ュ ョ ヮ ヵ ヶ`, U+31F0–31FF(ㇰ–ㇿ) |
| | `！ ％ ） ， ． ： ； ？ ］ ｝ ｡ ｣ ､ ･ ｰ ﾞ ﾟ` |
| 줄 끝 금지(이 글자 뒤에서 나누지 않음) | `( [ { ‘ “ ‹ « （ ［ ｛ ｢ 「 『 〈 《 【 〔 〖 〘 〚 〝` |

- 계약 5.4 예시 글자는 모두 들어 있다(시험으로 고정).
- 곧은 따옴표 `"` `'` 는 여닫음을 알 수 없어 금칙 대신 결합 문자(2.3 규칙 6)로 둔다(UAX #14 QU). 공백 뒤 여는 따옴표 앞은 규칙 5 로 나뉜다.

### 2.5 정렬·공백·커닝

| 항목 | 구현 |
| --- | --- |
| left·right·center | 줄 폭 − 자연 폭(줄 끝 공백 제외)을 0·전부·절반 만큼 민다. 음수(줄 폭보다 넓은 한 클러스터)는 0 |
| justify | 마지막 줄·강제 줄바꿈 앞 줄·남는 폭 ≤ 0 은 left. 줄 안 공백(줄 머리 공백·줄 끝 공백 제외, 글리프가 있는 공백)이 있으면 남는 폭을 공백마다 같게 더한다. 없으면 글리프가 있는 클러스터 사이(마지막 클러스터 뒤 제외)에 같게 나눈다 |
| 조정 표현 | 더한 폭은 그 클러스터의 `PlacedGlyph.advance` 에 들어가고 다음 글리프 x 가 그만큼 밀린다. Tw 는 쓰지 않는다. 쓰기는 x 차이를 TJ 숫자로 바꾼다 |
| 줄 끝 공백 | 폭·`PlacedLine.x1`·`contentBox` 에서 뺀다. 글리프는 `WritableGlyph` 에 남는다(x1 뒤에 이어 놓임) |
| 줄 끝 커닝 | 줄의 마지막 내용 클러스터는 다음 클러스터와의 커닝 몫(`kernAfter`)을 뺀 전진량을 쓴다 |
| `unknown` 정렬 | 타입에는 없으나 left 로 처리 |

### 2.6 초과·shrink·expand·keep

| 항목 | 구현 |
| --- | --- |
| 초과 | 마지막 줄 기준선 − 내림(내림은 음수)이 영역 아래 + 0.5pt 를 넘으면 `overflow = true`. 빈 줄도 마지막 줄이면 센다(캐럿 자리) |
| `null` | 배율 1, 초과 표시만 |
| shrink | 배율 1 에서 넘치면 s = 0.99, 0.98, …, 0.80 순서로 줄 나눔부터 다시 해 처음 들어가는 s(= 들어가는 가장 큰 s). 줄 나눔이 s 에 단조가 아닐 수 있어 이분 탐색을 쓰지 않는다. 0.80 에서도 넘치면 s = 0.80, `overflow = true`. s 는 정수 백분율 / 100 |
| expand | 배율 1 에서 넘치면 영역 아래 = min(상한 아래, 마지막 줄 아래). 상한에 막혀 0.5pt 넘게 남으면 `overflow = true`. 넘치지 않으면 영역을 바꾸지 않는다(줄이지 않음) |
| keep | 배율 1, 넘친 줄도 그대로 놓고 쓴다. `overflow = true`. `isOverflowClipped(summary, areaLimit)` 가 `contentBox` 가 상한 밖으로 0.5pt 넘게 나가는지 돌려준다(pdf-ops·core 가 `overflow-clipped` 경고를 붙일 때 쓴다) |

### 2.7 출력 규약

| 항목 | 규약 |
| --- | --- |
| `PlacedLine.start`·`end` | 줄들이 텍스트 [0, 길이)를 빈틈 없이 덮는다. 줄 끝 공백과 강제 줄바꿈 문자는 그 줄 안에 든다. 빈 텍스트와 끝 빈 줄은 start = end |
| `PlacedLine.ascent`·`descent` | `FontFace` 와 같은 부호: 올림 양수, 내림 음수(pt, 배율 적용). 줄 상자 = [기준선 − ascent, 기준선 − descent]. 글리프가 있는 클러스터의 최댓값·최솟값, 없으면(빈 줄) 그 위치 구간(길이 0 구간 우선, 없으면 앞 구간)의 폰트·크기. 폰트 정보가 없으면 0.8·−0.2 em |
| `PlacedLine.x0`·`x1` | 줄 첫 클러스터 x, 마지막 내용 클러스터 끝(줄 끝 공백 제외). 빈 줄은 정렬 기준점(left: 줄 왼쪽, right: 줄 오른쪽, center: 가운데) |
| `PlacedGlyph` | 강제 줄바꿈을 뺀 클러스터마다 1개. glyph-missing 은 `font.kind = 'missing'`, 전진 0, 현재 펜 위치 |
| `WritableGlyph` | 글리프마다 1개(한 클러스터가 여러 글리프면 같은 offset·length). `lines` 길이 = `summary.lines` 길이(빈 줄은 빈 배열). missing·강제 줄바꿈 없음 |
| `contentBox` | 줄 상자(줄 끝 공백 제외, 빈 줄 포함)의 합집합. 빈 텍스트는 폭 0 상자 |
| `fontScale` | shrink 결과 s, 그 밖 1 |
| 결정성 | 같은 입력이면 `reflowMs` 를 뺀 결과가 같다(시험: 네 초과 선택 × 정렬 justify, 폴백 폰트) |
| 입력 검사 | 구간이 [0, 길이)를 빈틈·겹침 없이 덮지 않거나 크기가 양수가 아니면 예외(호출자 계약 위반). 빈 텍스트는 구간 0개 또는 길이 0 구간 |

## 3. 셰이퍼(계약 D5)

| 항목 | 구현 |
| --- | --- |
| 인터페이스 | `Shaper.shape(text, 클러스터 범위[]) → (ShapedCluster \| null)[]`. `ShapedCluster` = 글리프(gid·코드·전진량·xOffset·PDF 폭) 목록, 전진량 합, 다음 커닝 몫. null = 쓸 수 없음(missing 으로 배치) |
| pdf-widths | `encode(클러스터)` 의 명세 폭을 전진량·PDF 폭으로 그대로 쓴다. 커닝 없음. null·빈 배열이면 missing |
| opentype | harfbuzzjs 1.6.2. 기능 `kern=1`, `liga·clig·dlig·calt·ccmp·locl·rlig = 0`. 방향 LTR, 언어 미설정(`guessSegmentProperties` 를 부르지 않아 기본 언어도 들어가지 않음) |
| 스크립트 | 클러스터 첫 코드 포인트로 Hang·Latn·Hani·Hira·Kana·Grek·Cyrl·Zzzz. Common·Inherited 는 앞 스크립트(맨 앞이면 뒤 스크립트)를 따르고, 스크립트가 바뀌는 곳에서 나눠 셰이핑한다. 번들 폰트의 kern 은 latn·hang·DFLT 모두 같은 값이었다(“AV” −18, “To” −76 등, 실측) |
| 검사·대체 | 클러스터의 출력 gid 가 모두 “그 클러스터 자기 코드 포인트(기본 무시 문자 제외)의 cmap gid” 가 아니거나, harfbuzz 가 클러스터를 합쳤으면(글리프 없는 클러스터와 그 앞 클러스터) 그 클러스터를 cmap gid + hmtx 폭(커닝 없음)으로 대신한다. 계약의 “cmap 역상에 없으면” 보다 좁은 조건이다(6절 N4) |
| 기본 무시 문자 | ZWJ·ZWNJ·SHY·ZWSP·변이 선택자 등(`\p{Default_Ignorable_Code_Point}`)은 폴백 폰트로 쓰지 않는다. harfbuzz 는 이 문자를 전진 0 의 공백 글리프(gid 1)로 내는데, 그대로 쓰면 추출에 공백이 끼어든다(수정 2 이전 폰트에서는 U+00A0). 기본 무시 문자만으로 된 클러스터는 missing |
| 다음 커닝 몫 | 클러스터 마지막 글리프의 (harfbuzz 전진 − hmtx 전진). 전진 0 글리프(결합 표지)는 0 |
| 코드 | 폴백 폰트는 2바이트 big-endian gid(Identity-H, 계약 5.5) |
| PDF 폭 | `source.pdfWidth(gid)`(MuPDF `addFont` 의 /W). 배치는 harfbuzz 전진량을 쓰고, 쓰기가 차이(= 커닝)를 TJ 로 보정한다 |
| 캐시 | 폰트 키별 harfbuzz Face·Font·cmap·hmtx 조회(최대 4개). 같은 키에 길이가 다른 바이트가 오면 다시 만든다 |
| 적재 | harfbuzzjs 는 import 시 top-level await 로 WASM 을 적재한다. 그래서 `layoutParagraph` 는 동기로 쓸 수 있다(6절 N3) |

## 4. V6 결과(2026-10-19 실측)

시험: `test/v6.test.ts`. 방법: MuPDF `PDFDocument.addFont(new Font('NotoSansKR', bytes))` 결과의 /W·/ToUnicode 를 파싱해 harfbuzz 결과와 대조. 배치 출력 왕복은 cmap 의 NFC 안정 문자 전부(강제 줄바꿈 문자 제외)를 한 글자씩 강제 줄바꿈으로 나눠 `layoutParagraph`(opentype, kern 만, pdfWidth = /W)로 배치한 쓰기 글리프 전부를 본다. MuPDF 추출은 쓰기 글리프를 `Tm`·`Tj`(2바이트 gid)로 그린 쪽의 구조화 텍스트다.

### 4.1 계약 수정 2 폰트(현재, 4,082,236 B)

| 항목 | 결과 | 판정 |
| --- | --- | --- |
| harfbuzz 적재 | 성공. upem 1000, 글리프 16,966, cmap 16,567 코드 포인트 → gid 16,567(일대일), 모두 NFC 안정 | 통과 |
| 폰트 구성 | Type0 Identity-H, CIDFontType2, CIDToGIDMap 없음(= Identity), /DW 없음 | 확인 |
| /W vs hmtx | /W 항목 16,966(전 글리프). harfbuzz `glyphHAdvance` 와 최대 차이 0(허용 기준 1/1000 em) | 통과 |
| GSUB·GPOS 기능 | GSUB: aalt·calt·ccmp·dlig·fwid·hwid·liga·locl·pwid·vert·vjmo·vrt2. GPOS: halt·kern·palt·vert·vhal·vpal(mark·mkmk 없음) | 확인 |
| kern 만 셰이핑 | `fi` → gid 71·74(기본 기능이면 합자 gid 16288), `office`·`——`·`ffl` 모두 cmap gid. 한국어 문장의 공백 → gid 1(폭 224). kern 적용(“To” −76/1000 em 등) | 통과 |
| cmap gid ToUnicode | 16,567 gid 모두 항목 있음, 모두 자기 코드 포인트로 정확히 왕복. 다대일 0 | 통과 |
| 배치 출력 왕복 | 16,567자 중 16,566자 씀(U+3164 HANGUL FILLER 는 기본 무시 문자라 쓰지 않음). 모든 쓰기 gid 의 ToUnicode = 자기 클러스터, 불일치 0 | 통과 |
| MuPDF 추출(표본 문장) | `한글 PDF 편집기 漢字 不可 ㄱㄴ “quote” — dash € ™ office fi To-day 2026`: 공백류를 뺀 추출 = 입력. 공백은 U+0020 으로 추출(U+00A0 없음) | 통과 |

### 4.2 수정 2 이전 폰트(4,083,596 B, 보고 근거)

| 항목 | 결과 |
| --- | --- |
| /W vs hmtx | 16,968 글리프 차이 0 |
| cmap | 16,892 코드 포인트 → gid 16,569. 317 gid 를 여러 코드 포인트가 공유 |
| ToUnicode | MuPDF `addFont` 는 다대일 gid 에서 가장 큰 코드 포인트를 고른다(317/317) |
| 배치 출력 왕복 | 316자 불일치: ASCII 2(U+0020 → U+00A0, U+002D → U+2011), 일반 구두점 3(U+2003 → U+3000, U+2012 → U+2013, U+2035 → U+FF40), CJK 기호 1(U+301C → U+FF5E), 호환 자모 51(U+3131–3163 → 반각 U+FFA1–FFDC), 통합 한자 259(예: 不 U+4E0D → U+F967, KS X 1001 호환 한자가 같은 글리프를 가리킴). 기본 무시 문자 U+00AD·U+3164 는 쓰지 않아 제외 |
| MuPDF 추출(표본 문장) | 不 → U+F967, ㄱ → U+FFA1, ㄴ → U+FFA4, `-` → U+2011, 공백 → U+00A0 |

- 2026-10-19 메인 세션에 보고(N1), 메인 세션이 안 A(서브셋 cmap 일대일)로 계약 수정 2 를 커밋했다. 이 브랜치는 수정 2 를 머지한 뒤 4.1 로 다시 확인했다.

## 5. 배치 시간(2026-10-19 실측)

시험: `test/bench.test.ts`. 500자 문단(한국어·영어·한자·숫자·괄호 혼합 문장 반복), 영역 폭 300pt, 크기 10pt, justify, 11줄. 워밍업 20회 뒤 200회(shrink 50회) 측정, `layoutParagraph` 호출 전체 시간. 계약 수정 2 폰트로 3회 실행한 범위.

| 경우 | 중앙값 | p95 | 최대 |
| --- | --- | --- | --- |
| 원본 폰트(pdf-widths) | 0.273–0.276 ms | 0.596–0.611 ms | 1.059–1.295 ms |
| 폴백 폰트(harfbuzz, kern) | 0.509–0.532 ms | 1.266–1.468 ms | 2.042–2.130 ms |
| 폴백 + shrink 최악(21개 배율 모두 시도, 결과 0.80·초과) | 0.584–0.601 ms | 0.798–0.863 ms | 0.830–0.874 ms |
| 폴백 첫 호출(4 MB 폰트 harfbuzz 적재·cmap 조회 포함) | 19.3–19.9 ms | — | — |

- 편집 반응 잠정 목표 p95 100 ms(계약 1.1·8.4) 대비 리플로우 몫은 약 1.5% 이하다. 첫 호출 적재는 폰트 키당 한 번(캐시).
- 수정 2 이전 폰트의 같은 측정도 같은 범위였다(폴백 중앙값 0.532–0.561 ms, 첫 호출 19.2–20.3 ms).
- 측정은 서버 Node 이고, 확장 Worker(Chromium) 수치는 통합 단계 8.4 측정에서 다시 본다.

## 6. 계약 불일치·모호(보고 대상)

| # | 내용 | 영향 | 제안 | 상태 |
| --- | --- | --- | --- | --- |
| N1 | V6 “모든 출력 gid 의 ToUnicode 왕복” 불성립. 번들 폴백 서브셋 cmap 이 다대일(317 gid)이고 MuPDF `addFont` ToUnicode 는 최대 코드 포인트를 고른다. 공백 → U+00A0, `-` → U+2011, 호환 자모 → 반각, 통합 한자 259자 → 호환 한자 | 폴백 폰트로 쓴 해당 문자의 복사·검색·8.3 텍스트 판정 실패(공백류 제외). 원본 폰트에 하이픈·공백·자모가 없는 서브셋 문서에서 흔히 발생 | A(권고, 메인 세션): `scripts/fonts/build-noto-sans-kr-subset.sh` 에서 cmap 을 일대일로 만든다(패자 코드 포인트 제거: U+00A0·U+00AD·U+2011·U+2003·U+2012·U+2035·U+301C 또는 U+FF5E 중 하나·U+FFA0–FFDC·U+F900–FA0B 등). B(S1): FontManager 가 `addFont` 뒤 폴백 /ToUnicode 를 선호 코드 포인트로 다시 쓴다. 둘 다 reflow 변경 없음 | 해소: 메인 세션이 안 A 로 계약 수정 2(m3 `64f6fcd`) 커밋, 이 브랜치에 머지(`1b640dd`), V6 재확인 통과(4.1) |
| N2 | `PlacedLine.descent` 부호가 shared-types 에 정해져 있지 않다 | 뷰어 캐럿·선택 상자, core 변경 영역 | reflow 는 `FontFace` 와 같이 내림 음수로 낸다(2.7). shared-types 주석에 명시하는 것을 제안(메인 세션 소관) | 기록 |
| N3 | harfbuzzjs 는 import 시 top-level await 로 `harfbuzz.wasm` 을 적재한다 | reflow 를 import 하는 core Worker 번들은 TLA 지원과 wasm 파일 위치(`import.meta.url` 기준)가 필요하다 | S4 의 “Worker 번들에 harfbuzz.wasm 포함” 항목에서 확인 | 기록 |
| N4 | 계약 D5 의 대체 조건 “출력 gid 가 cmap 역상에 없으면” 을 “그 클러스터 자기 코드 포인트의 cmap gid 가 아니면” 으로 좁혔고, 기본 무시 문자는 폴백 폰트로 쓰지 않는다 | 숨긴 기본 무시 문자가 공백 글리프(gid 1)로 쓰여 추출에 공백이 끼는 것을 막는다. 기본 무시 문자만으로 된 클러스터는 FontManager 경고 없이 missing 이 된다 | 8.3 텍스트 판정에서 기본 무시 문자를 공백류처럼 빼는 것을 제안(메인 세션). FontManager 가 기본 무시 문자를 폴백에 배정할 때 경고하지 않아도 된다 | 기록 |
| N5 | U+00AD(SHY) 뒤를 줄 나눔 기회로 두지만, 그 자리에서 나눠도 하이픈을 그리지 않는다(SHY 는 쓰지 않음) | 줄 끝 하이픈 표시 없음 | v1 범위 밖으로 둔다 | 기록 |
| N6 | 계약 11절 실측의 `fi` → gid 11878 은 D12 이전 서브셋 기준이다. 현재(수정 2) 서브셋은 기본 기능에서 gid 16288 | 없음(kern 만 쓰면 합자 없음) | 기록만 | 기록 |
| N7 | index.ts 에 내보내기를 더했다(`isOverflowClipped`·금칙 표·`OPENTYPE_FEATURES_OFF`). 고정 타입·시그니처는 그대로다 | 없음 | — | 기록 |

## 7. 검증(2026-10-19, 계약 수정 2 머지 후 `b325d19` + 이 문서)

| 명령(worktree 루트) | 결과 |
| --- | --- |
| `pnpm exec turbo run build typecheck test --force` | 24/24 작업 성공(캐시 0, 39.3 s). 시험: shared-types 2, layout-recon 40(3 건너뜀), reflow 54, pdf-ops 314(2 건너뜀), core 116(3 건너뜀), viewer-ui 120, extension 21, spike-m0 33(1 건너뜀) |
| `pnpm lint` | 통과(오류 0) |
| `pnpm exec prettier --check .` | 통과 |
| reflow 시험 | 5파일 54개 통과(줄 나눔 15, 배치 24, opentype 9, V6 5, 배치 시간 1) |

- pdf-ops·core 시험 로그의 MuPDF `library error`·`format error` 줄은 기존 시험이 일부러 넣은 잘못된 폰트·CMap 의 경고이고 실패가 아니다.
