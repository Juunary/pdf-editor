# M1 core: 추출 모델·검색·Stream 입력

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-19 |
| 범위 | `docs/m1-contract.md` 5.2절(`extractPage`·`searchText`·Stream 입력) |
| 브랜치 | `m1-core` (기준: 계약 커밋 97a6fb4, 계약 수정 1·2 머지) |
| 환경 | 서버 Node 22.18.0, mupdf 1.28.1. 브라우저·Windows 는 미측정 |
| 재현 | `pnpm --filter @pdf-editor/core build` 후 `node packages/core/scripts/measure-m1.mjs <fixtures｜dir <폴더>｜gen <out> [쪽수]｜compare <file>>` |

## 1. 상태

| 항목 | 상태 |
|---|---|
| V1 (Form 재귀 순서) | 확인됨(2.1) |
| V3 (글리프 정확히 한 번) | 포인터 규칙 불일치를 보고했고, 사용자 결정 "첫 등장 계수"(계약 3.1)로 구현·검증 완료(2.2–2.4) |
| `extractPage` | 구현. 합성 PDF 55건 + 실제 코퍼스 1,647쪽 무예외(4절) |
| `searchText` | 구현. 대소문자·순환·pageLimit·maxHits·truncated 테스트 10건 |
| Stream 입력(A3-1) | 구현. 저장 바이트 동일·열기 힙 +0(5절) |
| 쪽 캐시 | `PdfSession.extractPage` 최근 사용 순 16쪽, `invalidatePageCache(pageIndex?)` |
| 미결 | 7절. 특히 합성 공백이 모델에 없음(7.1) |

## 2. 검증 전제 확인 (2026-10-19, 서버 Node, 합성 PDF)

재현 코드: `packages/core/test/mupdf-text-callbacks.test.ts`(MuPDF 관측 9건), `packages/core/test/extract.test.ts`(추출 55건).

### 2.1 V1: 확인됨

- `runPageContents` Device 콜백은 `Do` 위치에서 Form 안 텍스트를 콘텐츠 실행 순서로 보낸다. 관측 순서: `fillText(A)` → `clipPath` → `fillText(XY, Form 안)` → `popClip` → `fillText(Z)`.
- Form XObject 에 `/BBox` 가 있으면 `Do` 한 번이 `clipPath` 1개(+ `popClip`)를 만든다. paintSeq 를 1 쓴다.
- 장치 CTM 은 페이지 변환(`PDFPage.getTransform()`)이고 글리프 `trm` 은 CTM 적용 전 사용자 공간이다. 페이지 공간 글리프 행렬은 `Matrix.concat(trm, ctm)`. 구조화 텍스트 원점과 일치(회전 90 쪽 포함).

### 2.2 V3: 포인터 규칙 불일치 (계약 수정 전 보고 내용)

"ABCD" 4글리프를 `BT … ET` 한 개로 표시했을 때:

| Tr | 콜백 순서 | fill/stroke 와 clip 의 텍스트 객체 | 계약 3절 초안 규칙으로 센 수 |
|---|---|---|---|
| 0 / 1 / 3 | fillText / strokeText / ignoreText | - | 4 |
| 2 | fillText → strokeText | 동일 | 4 |
| 4 | fillText → clipText → popClip | **다름** | **8** |
| 5 | strokeText → clipText → popClip | **다름** | **8** |
| 6 | fillText → strokeText → clipText → popClip | fill=stroke 동일, clip **다름** | **8** |
| 7 | clipText → popClip | - | 4 |

추가 관측

- `clipText` 는 `BT … ET` 의 Tr 4–7 글리프를 모아 한 객체로, 새로 만들어 ET 시점에 다시 보낸다(ET 재전송). fill 이 색 변경으로 여러 번이어도 clip 은 한 번이다. Tr 4 와 Tr 7 이 섞이면 Tr 7 글리프는 clipText 에만 있다.
- 패턴·셰이딩 색 텍스트는 Tr 0 이어도 fillText 없이 `clipText → (fillShade｜beginTile…endTile) → popClip` 으로 온다. 수정안 A(클립 미계수)는 이 텍스트를 빼서 폐기되었다(`docs/m1-contract.md` 3.1 말미).
- 구조화 텍스트도 Tr 4–6 글리프를 두 번 담는다(같은 원점·유니코드의 줄 2개).
- 포인터 비교 전제: 콜백 직후 `Text` 래퍼를 `destroy()` 하면 C 객체가 해제되어 다음 텍스트 객체가 같은 주소를 받는다. 서로 다른 텍스트 객체 100개에서 직전과 포인터가 같았던 횟수: 래퍼 유지 0회, 즉시 `destroy` 99회(`mupdf-text-callbacks.test.ts`). core 는 직전 래퍼를 다음 콜백 비교가 끝날 때까지 유지한다.

### 2.3 구현한 계수 규칙 (계약 3.1)

`packages/core/src/extract-device.ts` `DeviceCollector`

| 계약 3.1 단계 | 구현 |
|---|---|
| 1 | `#showPainted`: 직전 콜백과 `text.pointer` 가 같은 fill↔stroke 는 건너뛰고 앞 글리프를 `fill-stroke` 로 바꾼다. 직전 래퍼는 `#prev` 에 유지 |
| 2 | fill/stroke 글리프에 번호를 주고 키 `fontId｜gid｜trm 6값 문자열` 로 "센 목록" `#counted` 에 넣는다 |
| 3 | `#showUnpainted`(clipText·clipStrokeText·ignoreText): 키가 센 목록 미소비 항목과 같으면 소비(세지 않음, 그 글리프 `clip = true`), 아니면 번호를 준다. 클립 콜백에서 새로 센 글리프는 센 목록에 넣는다 |
| 4 | 소비가 1개 이상이면 센 목록을 비운다 |
| 5 | `beginMask`~`endMask` 사이 콜백은 `guard` 가 건너뛴다(센 목록도 건드리지 않음) |

CharInfo 표기(계약 3.1 표): 클립 콜백에서 처음 센 글리프는 `invisible`·`clip true`·색 null. 그 클립의 popClip 전에 `fillShade`·`beginTile` 이 오면 `fill`·`clip false`·색 null 로 고친다(`#patternPaint`). ignoreText 에서 처음 센 글리프는 `invisible`·`clip false`·색 null.

paintSeq 세부(계약 3절 표)와의 대응: Form BBox `clipPath`·셰이딩 패턴 `clipPath + fillShade`·타일링 패턴 `clipPath` 는 콜백 수만큼 센다. `beginTile` 콜백이 1 을 돌려 MuPDF 가 패턴 셀 내용을 실행하지 않는다(0 을 돌려주면 셀이 실행되고, 60×60 영역에서도 셀 내용이 2번만 오는 등 쪽 콘텐츠 순서와 무관한 횟수로 온다). `beginGroup`·`endGroup` 은 세지 않는다.

### 2.4 알려진 한계 (계약 3.1 말미와 같음, 테스트로 고정)

- 같은 폰트·gid·trm 이 비트 단위까지 같은 글리프를 다른 BT 에서 그린 뒤 클립 콜백으로 다시 오면 재전송으로 오판한다(`extract.test.ts` "알려진 한계").
- BT 마지막 글리프가 Tr 0–2 이면 그 BT 의 Tr 7 글리프는 Device 에 오지 않는다(MuPDF 동작). 모델에도 없다.

## 3. 구현 범위

소스 `packages/core/src`

| 파일 | 내용 |
|---|---|
| `extract.ts` | `extractPageDetailed`(모델 + `ExtractStats`)·`extractPageModel`. Device 실행 → 구조화 텍스트 → 결합 → `PageModel`. MuPDF 로그를 실행 중에만 가로채 `warnings` 에 담고 끝나면 해제 |
| `extract-device.ts` | 사용자 정의 Device 수집기(글리프·경로·이미지·셰이드·클립 스택, 2.3 규칙) |
| `extract-stext.ts` | 구조화 텍스트 순회와 글리프 결합. 원점 격자 탐색(1pt 칸), 원점 0.05pt 이내 후보 우선·유니코드 같은 후보 우선, 어긋난 후보는 1pt 이내 최근접 |
| `color.ts` | 원래 색공간 값 + sRGB 근사. DeviceGray·DeviceRGB 는 직접, 그 밖(CMYK·ICC·Cal·Lab·Separation·DeviceN·Indexed)은 1×1 픽스맵 `convertToColorSpace(DeviceRGB)`. 값 단위 캐시 |
| `page-geometry.ts` | 쪽 회전·행렬·사각형 보조 |
| `search.ts` | `searchDocument` |
| `open.ts`·`session.ts` | Stream 입력, `planSave` 배율, 쪽 캐시, 추출·검색 연결 |
| `scripts/measure-m1.mjs` | 계측 |

PageModel 채우기 규칙

| 필드 | 규칙 |
|---|---|
| `chars[].text` | Device `unicode` 문자열. 합자 코드포인트(U+FB00–FB06)는 NFKC 전개. ToUnicode 가 글리프 하나를 여러 글자("Th", "fi", 점선)로 대응시키면 MuPDF 가 gid -1(폭 0) 항목을 덧붙이는데, 이는 글리프가 아니므로 세지 않고 앞 글리프 `text` 에 합친다(실제 코퍼스 첫 5쪽 근사 비율 약 8% → 0.1% 로 감소). 매핑이 없으면 "�" |
| `origin`·`size` | `Matrix.concat(trm, ctm)` 의 e·f, 두 번째 열 길이 |
| `quad`·`color`·`line` | 구조화 텍스트 글자와 짝이 되면 그 값(색은 8비트 sRGB). 아니면 quad 근사(위 0.95 em·아래 0.25 em, 가로폭 = `advanceGlyph`·글자 크기, 세로쓰기는 폭 1 em), 색은 Device 색, `line` -1, 경고 |
| `lines`·`blocks` | 구조화 텍스트 순서. 글리프와 짝이 된 글자만 담고 비는 줄·블록은 뺀다(Tr 4–6 중복 줄, 합성 공백, 주석 텍스트 제외) |
| `paths[].bbox` | 채움·클립: 경로 점(곡선은 제어점 포함)의 페이지 공간 경계. 선: MuPDF `Path.getBounds(stroke, ctm)`(열린 선은 마이터 한계 여유를 넓게 잡아 큼) |
| `shades[].bbox` | `Shade.getBounds()` 를 CTM 으로 옮기고 현재 클립 경계로 접는다. 경계가 ±2^31 근처(무한)이면 현재 클립 경계 |
| `images[].bbox` | 단위 사각형을 CTM 으로 옮긴 경계. 픽셀 수는 `getWidth/Height` (디코드하지 않음) |
| `rotation`·`userToPage` | 상속 반영 /Rotate, `PDFPage.getTransform()` |

예외 처리

- 구조화 텍스트 생성이 예외를 내도(`Unexpected mesh type …` 등) Device 정보만으로 모델을 만든다(모든 글자 quad 근사, 경고 `MuPDF: 구조화 텍스트 생성 실패: …`).
- Device 콜백 안 예외는 WASM 프레임을 거쳐 던지지 않고 모았다가 실행 뒤에 던진다.

### 3.1 MuPDF·mupdf.js 관측 (구현에 반영한 것)

| # | 관측 | 대응 |
|---|---|---|
| M1 | `fillShade` 콜백의 `Shade` 래퍼는 mupdf.js 가 참조를 늘리지 않고 만든다(Path·Text·ColorSpace·StrokeState·Image 는 늘린다). 래퍼가 GC 되면 소유하지 않은 참조를 놓아 셰이드가 해제된다. 실제 코퍼스에서 `Unexpected mesh type …` 후 `memory access out of bounds` 로 재현했고, 합성 셰이딩 + GC 반복으로도 재현했다(Node `--expose-gc`) | 래퍼 `destroy` 대신 종료자 등록을 해제(`releaseBorrowed`). 업스트림 보고 후보(7.3) |
| M2 | `Text.walk` 의 `showGlyph` 는 ToUnicode 다중 글자 글리프에 gid -1 항목을 덧붙인다. 그 항목으로 `Font.advanceGlyph` 를 부르면 `FT_Get_Advance(…,-1): invalid argument` 경고가 난다 | 세지 않고 앞 글리프에 합친다(위) |
| M3 | 구조화 텍스트 기본 옵션(`mediabox-clip`)은 쪽 밖 글자를 빼고, 글자 간격이 큰 곳에 합성 공백을 글자로 넣는다 | 4.3, 7.1 |
| M4 | `StructuredText.walk` 의 `onChar` 는 `String.fromCharCode` 라 BMP 밖 코드포인트가 잘린다 | 글자 텍스트는 Device `unicode` 를 쓰고 구조화 텍스트 글자는 위치·줄·quad·색에만 쓴다 |
| M5 | `Page.search` 는 쪽당 500 quad 에서 자른다(mupdf.js `runSearch`) | 500 에 닿으면 `truncated` |
| M6 | 검색 옵션 문자열: 기본 대소문자 구분, `ignore-case` 로 무시 | `caseSensitive` 기본 false 이므로 `ignore-case` 전달 |
| M7 | Tr 7 글리프는 BT 마지막 글리프가 Tr 4–7·3 일 때만 ET 에서 온다 | 2.4 |

## 4. 추출 실측 (2026-10-19, 서버 Node 22.18, 쪽당 1회 첫 추출, 캐시 제외)

### 4.1 fixtures/m0 (10쪽, 합성 문서, 모든 글리프 구조화 텍스트와 짝)

| 문서 | 쪽 | 크기(B) | 추출 ms | 글리프 | 근사 | 짝 없는 구조화 글자 | 도형·이미지·셰이드 | 경고 | WASM 힙(MiB) |
|---|---|---|---|---|---|---|---|---|---|
| m0-preexisting-redact-edited.pdf | 0 | 23,342 | 24.05 | 239 | 0 | 0 | 7 | 0 | 22 |
| m0-preexisting-redact-edited.pdf | 1 | 23,342 | 4.88 | 391 | 0 | 0 | 7 | 0 | 22 |
| m0-preexisting-redact.pdf | 0 | 14,428 | 6.99 | 391 | 0 | 0 | 7 | 0 | 22 |
| m0-preexisting-redact.pdf | 1 | 14,428 | 3.58 | 391 | 0 | 0 | 7 | 0 | 22 |
| m0-sample.pdf | 0 | 11,674 | 7.02 | 391 | 0 | 0 | 7 | 0 | 22 |
| m0-shared-xobject-edited.pdf | 0 | 12,361 | 8.33 | 382 | 0 | 0 | 16 | 0 | 22 |
| m0-shared-xobject-edited.pdf | 1 | 12,361 | 5.58 | 503 | 0 | 0 | 19 | 0 | 22 |
| m0-shared-xobject.pdf | 0 | 2,091 | 14.87 | 490 | 0 | 0 | 16 | 0 | 22 |
| m0-shared-xobject.pdf | 1 | 2,091 | 6.26 | 503 | 0 | 0 | 19 | 0 | 22 |
| m0-spike-saved.pdf | 0 | 20,766 | 6.96 | 239 | 0 | 0 | 7 | 0 | 22 |

- 쪽당 추출 3.6–24.1 ms(중앙값 7.0 ms; 24 ms 는 프로세스 첫 쪽의 워밍업 포함). WASM 힙은 기본 22 MiB 에서 늘지 않았다.
- 도형 수 16·19 인 쪽은 Form XObject `Do` 의 BBox 클립이 포함된 값이다(2.1).

### 4.2 실제 코퍼스 (`fixtures/corpus` PDF 19개 전체, 읽기 전용 사용)

`/mnt/nas4/kjune/pdf-editor/fixtures/corpus` 의 PDF 19개를 읽기만 했다(저장소 밖, 다른 세션이 쓰는 폴더이며 수정하지 않았다).

| 문서 | 쪽 | 글리프 | 근사 | 합성 공백 등 | 추출 합계 ms | 쪽 최대 ms | WASM 힙 최대(MiB) |
|---|---|---|---|---|---|---|---|
| arxiv-2609.09268 | 16 | 58,005 | 24 | 9,297 | 498 | 76 | 22 |
| arxiv-2609.10511 | 15 | 48,172 | 0 | 7,188 | 386 | 85 | 22 |
| fed-combined-finstmt-2025 | 63 | 154,246 | 302 | 1 | 906 | 60 | 38.1 |
| fed-h41-current | 11 | 28,778 | 19 | 28 | 136 | 19 | 38.1 |
| nasa-eo-2019-maraprl | 40 | 168,690 | 0 | 194 | 975 | 98 | 45.8 |
| nasa-eo-2023-sepoct | 63 | 260,927 | 13,658 | 0 | 1,221 | 105 | 45.8 |
| nasa-eo-2024-janfeb | 34 | 116,821 | 13 | 0 | 594 | 131 | 45.8 |
| nasa-se-handbook-sp2016-6105 | 297 | 802,960 | 1,391 | 1,131 | 6,732 | 242 | 65.9 |
| nist-ai-100-1 | 48 | 90,392 | 0 | 14,030 | 580 | 267 | 65.9 |
| nist-cswp29 | 32 | 68,496 | 25 | 0 | 290 | 16 | 65.9 |
| nist-sp800-171r3 | 120 | 257,572 | 7 | 1 | 1,717 | 351 | 65.9 |
| nist-sp800-53r5 | 492 | 1,629,511 | 7,040 | 0 | 9,342 | 532 | 65.9 |
| ustreas-mts-202509 | 40 | 134,666 | 0 | 325 | 1,684 | 756 | 65.9 |
| zen-beamer-10545284 | 54 | 47,261 | 13,429 | 3,801 | 1,083 | 605 | 79.1 |
| zen-beamer-7535020 | 81 | 23,705 | 4 | 2,415 | 912 | 593 | 95 |
| zen-ko-kimtw-23386644 | 18 | 23,262 | 0 | 216 | 340 | 31 | 95 |
| zen-ko-moon-21973474 | 22 | 24,809 | 0 | 840 | 395 | 55 | 95 |
| zen-ko-report-21333257 | 152 | 128,497 | 13 | 6 | 1,470 | 71 | 95 |
| zen-ko-sim-21496576 | 49 | 59,988 | 36 | 9,746 | 414 | 40 | 95 |
| **합계** | **1,647** | **4,126,758** | **35,961** | **49,219** | **29,673** | **756** | **95** |

- 1,647쪽 전부 예외 없이 추출됨(단일 프로세스 연속 실행; 힙은 줄지 않는 선형 메모리라 문서를 이어 열면서 22 → 95 MiB 로 늘었다. 문서 하나 단위 측정은 5절).
- 쪽당 추출 시간: 평균 18.0 ms, 중앙값 14.3 ms, p95 34.3 ms, p99 79.6 ms, 최대 755.7 ms(ustreas-mts 19쪽, 글리프 4,135·도형 등 938). 글리프 처리량 약 139 글리프/ms.
- 추출 합계 29.7 s(문서 열기 제외, 전체 실행 30.7 s).
- 클립 텍스트 경로(ET 재전송·패턴 색 텍스트)는 이 코퍼스에서 한 번도 나오지 않았다(재전송 0, 클립 첫 계수 0). 해당 규칙은 합성 문서로만 검증했다.

### 4.3 quad 근사 빈도

| 구분 | 값 |
|---|---|
| fixtures/m0 | 3,920 글리프 중 0 (0%) |
| 코퍼스 전체 | 4,126,758 글리프 중 35,961 (0.87%). 근사가 있는 쪽 626/1,647 (38%) |
| 상위 문서 | nasa-eo-2023 13,658(5.2%), zen-beamer-10545284 13,429(28.4%), nist-sp800-53r5 7,040(0.43%), nasa-se-handbook 1,391(0.17%). 이 4개가 근사의 97% |
| 원인 | 모두 **쪽 밖에 놓인 글자**다. 구조화 텍스트 기본 옵션이 `mediabox-clip` 이라 쪽 밖 글자를 빼므로 짝이 없다. 확인: beamer 6쪽 근사 654개의 원점이 x 2,033–2,415, y −1,836~−1,765 (쪽 453×255), nasa-eo 8쪽 근사 3,267개가 x 615–1,813 (쪽 612 너비). `mediabox-clip=no` 로 구조화 텍스트를 만들면 글자 수가 686 → 1,373, 5,069 → 8,336 으로 늘어 근사가 사라진다. nist-sp800-53r5 는 쪽 오른쪽 가장자리를 넘은 공백 글리프 |
| 처리 | quad 근사(줄 -1). 쪽 밖 글자는 텍스트 층·검색에서 제외되는 것이 현재 동작이다. 포함하려면 구조화 텍스트 옵션을 바꾸면 되나 텍스트 층에 쪽 밖 글자가 들어간다(7.2) |

### 4.4 짝 없는 구조화 텍스트 글자

코퍼스 전체 51,031개(구조화 텍스트 글자의 약 1.2%) 중 49,219개(96%)가 공백이다. MuPDF 가 글자 간격으로 합성한 공백이며 Device 글리프에는 대응이 없다(공백 글리프가 실제로 있으면 짝이 된다). 문서에 따라 글자의 약 16%(arxiv-2609.09268 9,297/58,005; nist-ai-100-1 14,030/90,392; zen-ko-sim 9,746/59,988)에 달한다. 현재 PageModel 에는 이 공백을 담을 곳이 없다(7.1).

## 5. Stream 입력 (A3-1) 결과 (2026-10-19, 서버 Node)

구현: `openPdf(bytes, { inputMode: 'stream' })` 가 `new mupdf.Stream({ fileSize, read, close })` 로 보관 중인 원본 바이트에서 MuPDF 가 필요한 구간만 읽게 한다(`read` 콜백이 `HEAPU8` 로 복사). `PdfSession.open` 기본값이 stream 이며 `OpenResult.inputMode` 는 `'stream'`. `planSave` 는 stream 일 때 `STREAM_INPUT_PEAK_HEAP_RATIO`(전체 3.48·증분 2.98)를 `decideSaveMethod` 의 `ratio` 로 넘긴다. buffer 는 `open(bytes, 'buffer')` 로 선택(비교·측정용).

| 확인 | 결과 |
|---|---|
| 저장 바이트 | 전체 저장(쪽 삭제 편집 후)·변경 없는 증분 저장 모두 Buffer 입력과 바이트 동일(`stream-input.test.ts`). 대형 합성 문서 100·300쪽에서 출력 길이도 같음(78,725,087 / 236,175,466 B) |
| 읽은 양 | 4 MiB 초과 합성 문서의 열기 + 1쪽 렌더가 읽은 양 < 파일의 1/4 (테스트) |
| JS 래퍼 해제 | `Stream` 래퍼를 열자마자 `destroy()` 해도 문서는 자기 참조를 유지해 렌더·저장이 된다 |
| 저장 전 판정 | stream: 전체 3.48·증분 2.98, buffer: 4.48·3.98 (테스트) |

열기·저장 힙(프로세스를 모드마다 따로 실행, 합성 대형 PDF — 쪽마다 768 KiB 비압축 잡음 이미지 1개와 텍스트 1줄. M0 의 생성기와 같은 종류이나 바이트는 다름)

| 문서 | 모드 | 열기 후 힙(MiB) | 열기 ms | 전체 저장 후 힙(MiB, 피크) | 피크 ÷ 파일 | `planSave` 예상 피크(MiB) | 저장 ms |
|---|---|---|---|---|---|---|---|
| 100쪽 (75.1 MiB) | buffer | 97.9 (+75.9) | 75.8 | 264.5 | 3.52 | 336.2 | 1,743 |
| 100쪽 (75.1 MiB) | stream | 22.0 (+0) | 4.3 | 189.5 | 2.52 | 261.2 | 1,738 |
| 300쪽 (225.2 MiB) | buffer | 278.0 (+256.0) | 216.6 | 624.1 | 2.77 | 1,008.7 | 5,147 |
| 300쪽 (225.2 MiB) | stream | 22.0 (+0) | 5.6 | 398.9 | 1.77 | 783.5 | 5,268 |

- Stream 입력은 열기 후 힙 증가가 0 이고 피크가 파일 크기 약 1배만큼 줄어, M0 실측(100쪽 4.48 → 3.48, 300쪽 2.85 → 1.85)과 같은 크기의 절감이다.
- 예상 피크는 이 문서들에서 실제 피크 이상이다(과소 추정 0건).
- 1쪽 추출 시간은 모드와 무관(17.3–18.4 ms, 이미지 1개 쪽).
- 브라우저 Worker 에서의 `read` 콜백 비용·탭 메모리는 미측정(M0 A3-4 와 함께).

## 6. 테스트

`pnpm --filter @pdf-editor/core test`: 6 파일 87건(계약 커밋 기준 7건).

| 파일 | 내용 |
|---|---|
| `mupdf-text-callbacks.test.ts` | MuPDF 콜백 관측(V1, Tr 별 콜백·포인터, 래퍼 해제 시 주소 재사용) 9건 |
| `extract.test.ts` | 글자·좌표·읽기 순서·회전·MediaBox 오프셋, glyphSeq 규칙(Tr 0–7, Form 재귀), 클립 텍스트 첫 등장 계수(타일링·셰이딩 패턴 색 텍스트, Tr 7 + `sh`, Tr 4/7 혼합, 알려진 한계), 패턴 셀·소프트 마스크 제외, quad 근사·합성 공백, 색공간(Gray·RGB·CMYK·Separation·Lab·Indexed), 도형(B 연산 번호 2개·짝홀·곡선·세그먼트·알파·클립), 이미지·인라인·마스크·셰이드, 주석 제외, MuPDF 경고, 캐시(LRU 16쪽·무효화), 합자·다중 글자 ToUnicode·DejaVu 합자 글리프, Shade 래퍼 GC 55건 |
| `search.test.ts` | 대소문자·순환·pageLimit·maxHits·truncated·다줄 결과·한글·빈 검색어·500 quad 상한·인자 오류 10건 |
| `stream-input.test.ts` | 저장 바이트 동일(전체·증분), 읽기량, 래퍼 해제, 배율 6건 |
| `session.test.ts` | 기존 4건 + 계약 커밋의 "M1 미구현" 테스트를 추출·검색 연결 테스트로 교체(5건). `open.test.ts` 2건은 그대로 |
| 공통 | `pdf-fixtures.ts`: 합성 PDF 생성(Helvetica F1, NotoSansKR 부분집합 F2) |

참고: GC 회귀 테스트("Shade 래퍼")는 `--expose-gc` 가 필요해 `v8.setFlagsFromString` + `vm` 으로 `gc` 를 얻는다. 이 테스트만으로는 수정 전 코드에서 실패를 재현하지 못했다(실제 코퍼스와 독립 스크립트 `own.mjs` 에서는 재현). 안전망 성격이다.

## 7. 미결 사항 · Action Items

### 7.1 합성 공백이 PageModel 에 없음 — 계약 갭 (메인 세션 결정 필요)

- 현상: 4.4. 복사한 텍스트가 TJ 간격으로 단어를 나눈 문서(LaTeX 등)에서 "HelloWorld" 로 붙을 수 있다. 이 PageModel 로 Ctrl+C 를 만들면 문서에 따라 글자의 약 16%가 공백인데 빠진다.
- 제안(shared-types 변경, 메인 세션 권한): `LineInfo` 에 `spaceAfter: number[]`(= `LineInfo.chars` 의 위치 k 뒤에 공백을 넣는다)를 추가한다. 글자 `text` 를 오염시키지 않고 선택·복사 조립만 쓴다. core 는 이미 줄 안에서 짝 없는 공백 위치를 알고 있어 변경 범위가 `assemble` 한 곳이다. 대안: `LineInfo.text`(공백 포함 읽기 텍스트).
- viewer-ui 세션과 읽는 쪽을 맞춰야 한다.

### 7.2 쪽 밖 글자 정책

- 현재 기본: 구조화 텍스트가 쪽 밖 글자를 빼므로 그 글자는 quad 근사·줄 -1(텍스트 층·검색 제외). 코퍼스의 근사 97% 가 이 경우(4.3).
- 선택지: `mediabox-clip=no` 로 포함(근사 사라짐, 텍스트 층에 쪽 밖 글자). 편집(M3)은 쪽 밖 글자도 SourceMap 으로 편집 대상이다. viewer 와 합의 필요.

### 7.3 mupdf.js 결함 후보 (업스트림 보고 후보, 이번에 게시하지 않음)

- `fillShade` Device 콜백의 `Shade` 래퍼가 참조를 늘리지 않아, 래퍼가 GC 되면 셰이드를 과다 해제한다(3.1 M1). `fillImage` 의 `Image` 는 정상. 재현: 셰이딩 쪽을 `runPageContents` 로 반복 실행 + GC (`own.mjs` 유형). `docs/upstream` 형식으로 정리하면 A2-4(mupdf.js#201)와 같은 방식으로 보고할 수 있다.

### 7.4 통합 시 확인

- pdf-ops `linkPage` 연결 후: `fixtures/m0`·코퍼스의 글리프·도형 총수 일치(계약 6절 2–3 단계). 특히 클립 텍스트 규칙(3.1)은 코퍼스에 사례가 없어 합성 문서 검증뿐이다.
- 문서 편집 기능(M2/M3)은 내용이 바뀔 때 `PdfSession.invalidatePageCache` 를 불러야 한다.
- 세로쓰기(wmode 1)·Type3 폰트·ICC 색은 합성 문서를 만들지 못해 코드 경로만 있고 테스트가 없다. 해당 문서를 코퍼스에 추가해 확인한다.
- 브라우저(Windows Chrome)에서 `extractPage` 결과의 Comlink structured clone 비용·`PageModel` 크기(쪽당 글리프 수천 개, 객체 수만 개)는 미측정.

### 7.5 변경하지 않은 것

- `packages/shared-types`, `packages/pdf-ops`, `pnpm-lock.yaml`, 루트 설정, 새 의존성.
- `getSourceMap`·`linkPage` 는 pdf-ops 함수 호출 그대로(이 브랜치에서는 "M1 미구현").
