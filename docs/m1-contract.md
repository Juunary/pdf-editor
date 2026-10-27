# M1 계약: 추출 모델 · 원본 연결 정보 · 매칭 · 검색 · RPC

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-19 |
| 범위 | PLAN.md 6절 M1(추출·원본 연결) 병렬 구현의 공통 기준 |
| 기준 | `m1` 브랜치의 계약 커밋(이 문서와 `packages/shared-types/src` 를 포함한 커밋). 모든 M1 작업은 이 커밋에서 시작한다 |
| 변경 권한 | `packages/shared-types`, 루트 설정(eslint·tsconfig.base·turbo·pnpm-workspace), `pnpm-lock.yaml` 은 메인 세션만 바꾼다(PLAN.md 10절) |
| 제외 | DocumentModel(M2), EditOp·EditPlan(M3)은 각 마일스톤 시작 시 같은 방식으로 추가한다 |
| 변경 이력 | 수정 1(62067d3): V5 정정, paintSeq 세부(Form BBox·패턴·SMask), V3 결정 대기. 수정 2(2026-10-19): V3 계수 규칙 확정 — 사용자 결정으로 "첫 등장 계수"(3.1). 수정 3(2026-10-19): 합자 보조 글리프(gid -1) 미계수, 타일링 패턴 직접 실행 경로, 마스크 있는 이미지 콜백 2개. 수정 4(2026-10-19): 재전송 판정 키에 콜백 ctm 포함, 센 목록은 항목 단위 소비. 수정 5(2026-10-19): LineInfo.spaceAfter(합성 공백 위치) 추가, 읽기 텍스트 조립 규칙. 수정 6(2026-10-19): 3.1 1단계를 콜백 종류와 무관한 포인터 동일 건너뛰기로 정정, BT 안 Q·Form Do 재전송 한계 추가 |

## 1. M1 완료 기준(PLAN.md 6절)

- `PageModel` + `SourceMap` 생성, Form XObject 재귀, 매칭 실패율 측정, 디버그 오버레이, 코퍼스 회귀 테스트.
- 텍스트 선택 층·Ctrl+F: 확장이 켜진 상태에서 Chrome 기본 뷰어와 같은 검색·복사가 된다. 선택 → 복사 결과가 추출 텍스트와 일치하고, 검색 하이라이트 위치가 quad 와 일치한다(Playwright).
- M1 중 결정할 항목: A1-1(Form 이 있는 페이지 직접 편집 후처리), A1-3(Resources 상속 Form), A3-6(`garbage=yes` 전환)·A2-3(이미지 XObject `resolve()` 금지의 코드 규칙화).

## 2. 좌표계

| 공간 | 정의 | 쓰는 곳 |
|---|---|---|
| 페이지 공간 | MuPDF 페이지 좌표. 페이지 경계 기준 원점 좌상단, y 아래, pt. `/Rotate`·박스 오프셋 반영. `Page.getBounds()`·구조화 텍스트·항등 행렬 Device 콜백의 값 | `PageModel` 의 모든 기하, `SourceGlyph.origin`, 검색 quad |
| 사용자 공간 | PDF 기본 사용자 공간. 원점 좌하단, y 위 | `SourceOp.ctm`(콘텐츠 공간 → 사용자 공간), `TextShowInfo.tm`, `FormStep.ctm` |

- 사용자 공간 → 페이지 공간 = `PDFPage.getTransform()` = `PageModel.userToPage` = `SourceMap.userToPage`.
- 바이트 범위는 디코드한 스트림 바이트 기준 [start, end) 이다.

## 3. 순서 번호(seq)와 매칭

매칭 키는 "콘텐츠 실행 순서" 이다. MuPDF 인터프리터와 pdf-ops 인터프리터는 같은 콘텐츠를 같은 순서로 실행하므로, 순서 번호가 같으면 같은 글리프·도형이다. 원점 좌표는 검증에만 쓴다.

| 번호 | 세는 대상 | 규칙 |
|---|---|---|
| glyphSeq | 텍스트 콜백(fillText·strokeText·clipText·clipStrokeText·ignoreText)의 글리프 | 표시 글리프마다 1. 처음 Device 에 도착한 콜백에서 센다. fill→stroke(Tr 2·6, 포인터 동일 연속)는 1회, Tr 4–7 클립의 ET 재전송은 세지 않는다. gid -1 보조 글리프(ToUnicode 1코드→여러 코드포인트)는 세지 않고 직전 글리프의 text 에 붙인다. 판정 규칙은 3.1(확정) |
| paintSeq | 텍스트 외 그리기 콜백(fillPath·strokePath·clipPath·clipStrokePath·fillShade·fillImage·fillImageMask·clipImageMask) | 콜백마다 1. 채움+선(B·B*·b·b*)은 2. 경로가 비어도 칠하기 연산은 콜백을 보낸다. 세부는 아래 표 |

- core 는 `runPageContents`(주석 제외)를 항등 행렬로 실행해 센다. pdf-ops 인터프리터는 같은 규칙으로 센다.

paintSeq 세부(실측 2026-10-19, `docs/m1-pdf-ops.md` 2·5절, `docs/m1-core.md` 2절)

| 상황 | Device 콜백 | 계수 |
|---|---|---|
| Form XObject `Do` | 내용보다 먼저 BBox `clipPath` 1개(+ 끝에 popClip) | 1. SourceMap 에서는 그 `Do` 연산의 `paintSeq` |
| 셰이딩 패턴 색 f / S / B | clipPath+fillShade / clipStrokePath+fillShade / 4개 | 콜백 수만큼 |
| 타일링 패턴 색 칠하기 | (칠할 영역/XStep > 1 또는 영역/YStep > 1, 블렌드 없음) clipPath + beginTile. 그 밖은 beginTile 없이 clipPath + 셀 내용 콜백을 타일 수만큼 직접 실행 | clipPath 1. beginTile 경로: core 는 `beginTile` 이 1(캐시됨)을 돌려 셀 내용을 실행시키지 않고, pdf-ops 는 셀 스트림을 해석하지 않는다. 직접 실행 경로: core 는 받은 대로 세고, pdf-ops 는 실행 조건과 타일 수를 계산해 셀 내용 번호를 소비한다. 셀 내용의 paintSeq 는 그 패턴 칠하기 연산의 `paintSeq` 에 포함하고 그 연산에 `outside-page-content` 제한을 단다. 셀 내용 글리프는 소유 연산 없이 번호만 소비한다(해당 글자는 `unmatched`) |
| 소프트 마스크(SMask) | beginMask ~ endMask 사이 마스크 내용 콜백 | `beginMask`~`endMask` 사이 콜백은 glyphSeq·paintSeq 모두 세지 않는다. pdf-ops 는 SMask 그룹 스트림을 해석하지 않는다. 그 구간 밖의 콜백(예: 마스크 앞의 clipPath)은 센다 — pdf-ops 가 실측으로 확인 |
| 이미지 XObject / 인라인 이미지 / `/IM true` 인라인 | 마스크 없음: fillImage / fillImage / fillImageMask. `/SMask` 또는 스트림 `/Mask`(스텐실): clipImageMask → fillImage(+popClip). 색 키 `/Mask` 배열: fillImage | 마스크 없음 1, `/SMask`·스트림 `/Mask` 2, 색 키 마스크 1 |
| `ca`·블렌드 | beginGroup/endGroup | 세지 않음 |
- 매칭(`linkPage`): 같은 번호끼리 짝짓고, 원점 오차가 `originTolerance`(기본 1pt) 이하인지 확인한다. 번호가 어긋난 구간은 원점으로 재동기화를 시도하고, 실패한 글자·도형은 -1 과 `unmatched` 제한으로 남긴다. 총수 차이는 `LinkStats` 에 기록한다.

검증 전제(어긋나면 해당 작업이 즉시 메인 세션에 보고한다. 계약을 임의로 바꾸지 않는다)

| # | 전제 | 확인 담당 |
|---|---|---|
| V1 | `runPageContents` 의 Device 콜백은 Form XObject 재귀를 포함해 콘텐츠 실행 순서로 온다 | pdf-ops, core |
| V2 | MuPDF 는 여러 Tj/TJ 를 한 텍스트 콜백으로 묶을 수 있으나 글리프 순서는 보존한다 | pdf-ops |
| V3 | **정정(2026-10-19)**. MuPDF 는 BT 안의 Tr 4–7 글리프를 ET 에서 새 텍스트 객체로 다시 보내고(ET 재전송, 포인터 다름), 패턴 색 텍스트는 Tr 0 이어도 표시 시점 clipText 로 온다. 3.1 규칙으로 각 표시 글리프를 정확히 한 번 센다 | core, pdf-ops |
| V4 | 채움+선 연산은 fillPath → strokePath 콜백 2개다 | pdf-ops |
| V5 | **정정(2026-10-19)**. 꺼진 /OC 안의 fill/stroke 경로·이미지·셰이드·Tr 0–2 텍스트(Tr 4–6 의 표시 부분 포함)와 `/OC` 가 꺼진 Form·이미지 XObject 는 Device 에 오지 않는다. 클립(`W n`, Form BBox), Tr 3 텍스트, Tr 4–7 의 ET 재전송은 온다. pdf-ops 는 Device 에 오지 않는 글리프만 `seq` 를 null 로 두고, 꺼진 /OC 안의 연산 전부에 `optional-content` 제한을 단다 | pdf-ops |

### 3.1 클립 텍스트 계수 규칙(확정 2026-10-19, 사용자 결정: "첫 등장 계수")

원칙: 표시 글리프 1개 = glyphSeq 1개. 글리프는 처음 Device 에 도착한 콜백에서 번호를 받는다. MuPDF 가 BT 안의 Tr 4–7 글리프를 ET 에서 다시 보내는 것(ET 재전송)은 세지 않는다.

core 판정(콜백 순서대로)

| 단계 | 규칙 |
|---|---|
| 0 | gid -1 보조 글리프(ToUnicode 가 1코드를 여러 코드포인트로 매핑할 때 MuPDF 가 같은 trm 으로 덧붙이는 글리프)는 번호·센 목록 대상이 아니다. 같은 텍스트 객체에서 직전 글리프가 대응하는 CharInfo 의 text 에 유니코드를 붙인다(직전 글리프가 건너뛴 Tr 2·6 stroke 이거나 소비한 재전송이면 그 글리프의 CharInfo). 클립 재전송에는 보조 글리프가 들어가지 않는다 |
| 1 | 직전 텍스트 콜백과 텍스트 객체 포인터가 같은 텍스트 콜백은 **종류와 무관하게** 통째로 건너뛴다(같은 실행 단위의 fill→stroke, 패턴 색 clip→clipStroke, fill→clipStroke 등. Tr 2·6 과 패턴 색 Tr 6). ET 재전송은 항상 새 텍스트 객체로 오므로 이 규칙에 걸리지 않는다. 포인터 비교가 끝날 때까지 직전 콜백의 래퍼를 유지한다(즉시 destroy 하면 주소가 재사용된다) |
| 2 | fillText·strokeText: 글리프마다 번호를 주고 키(폰트 동일성, gid, 글리프 trm 6값, 콜백 ctm 6값 — 모두 비트 단위)를 "센 목록" 에 넣는다. 같은 키가 여러 번 들어오면 각각 별도 항목이다 |
| 3 | clipText·clipStrokeText·ignoreText: 글리프 키가 센 목록의 미소비 항목과 같으면 그 항목을 소비하고 세지 않는다(ET 재전송). 아니면 번호를 준다. clipText·clipStrokeText 에서 새로 센 글리프는 센 목록에 넣는다 |
| 4 | 3단계에서 1개 이상 소비한 콜백이 끝나면 센 목록을 비운다 |
| 5 | beginMask~endMask 사이 콜백은 세지 않고 센 목록도 건드리지 않는다 |

- 폰트 동일성은 core 재량(폰트 포인터·이름 등)이되 한 페이지 실행 동안 같은 PDF 폰트에 대해 안정적이어야 한다.
- 키에 ctm 을 넣는 이유: MuPDF 는 같은 Form 을 다른 위치에 그려도 글리프 trm 이 같고 콜백 ctm 만 다르다(메인 세션 재현 2026-10-19). trm 만으로는 다른 위치의 같은 글자를 재전송으로 오판한다. BT 안의 cm 은 MuPDF 가 클립 텍스트 누적 중 "CTM CHANGE IN CLIP TEXT" 로 해석을 중단하므로(pdf-ops 실측) 정상 콘텐츠에서 ET 재전송의 ctm 은 표시 시점 ctm 과 같다.
- 3단계의 "소비" 는 같은 키 항목 하나를 지우는 것이다(집합이 아니라 항목 목록).

CharInfo 표기(core)

| 글리프 | render | clip | color |
|---|---|---|---|
| fill·stroke 콜백에서 센 글리프 | fill / stroke / fill-stroke | false. 이후 ET 재전송을 소비하면 true(Tr 4–6) | 색 |
| ignoreText 에서 처음 센 글리프 | invisible | false | null |
| 클립 콜백에서 처음 센 글리프, 같은 클립의 popClip 전에 fillShade·beginTile 이 옴(패턴 색 텍스트) | fill | false | null |
| 그 밖에 클립 콜백에서 처음 센 글리프(Tr 7, 꺼진 /OC 의 Tr 4–6 재전송) | invisible | true | null |

pdf-ops 에뮬레이션

- MuPDF 전달 시점 표(`docs/m1-pdf-ops.md` 3.1)대로 글리프마다 첫 도착 시점을 계산해 번호를 준다.
  - 표시 시점: 보이는 콘텐츠의 Tr 0–6, 모든 Tr 3, 패턴 색 텍스트.
  - ET 재전송 시점: Tr 7 과 꺼진 /OC 의 Tr 4–6. 그 BT 의 마지막 글리프 Tr 이 4–7(clipText) 또는 3(ignoreText)일 때만 오며, 표시 순서대로 번호를 받는다.
  - Device 에 오지 않음: BT 마지막 글리프가 Tr 0–2 인 경우의 Tr 7, 꺼진 /OC 의 Tr 0–2·Tr 4–6 표시분 등 → `seq` null, 제한 `clip-text` 또는 `optional-content`.
- 패턴 색 텍스트·Tr 4–6 혼합도 같은 "첫 도착" 규칙이다. core 3단계가 실제 재전송을 소비하므로 양쪽 번호가 같다.
- `SourceOp.glyphSeq` 는 그 연산 글리프 번호의 [최솟값, 최댓값 + 1) 이며, ET 시점 번호 때문에 연속이 아닐 수 있다. 글자별 값은 `text.glyphs[].seq` 를 쓴다.

알려진 한계

- 같은 폰트·gid·trm·ctm 이 비트 단위까지 같은 글리프(같은 위치에 같은 글자)를 다른 BT 에서 그린 뒤 클립·숨김 콜백으로 다시 오면 core 가 재전송으로 오판한다. 양쪽 총수가 어긋나며 `linkPage` 원점 재동기화로 국소 복구하고, 해당 글자는 `unmatched` 다.
- 센 목록은 소비가 있을 때만 비우므로 재전송이 없는 BT 의 항목이 남는다. 오판 조건은 위와 같다.
- ignoreText 형태의 ET 재전송에서 처음 센 Tr 4–7 글리프는 core 가 Tr 3 과 구분하지 못해 clip false 로 표기한다. 정확한 렌더 방식은 pdf-ops `TextShowInfo.renderMode` 다.
- BT 안의 Q(비표준) 또는 BT 안의 Form `Do` 로 ET 재전송 시점 CTM 이 표시 시점과 달라지면 core 가 재전송을 찾지 못해 새 글자로 센다(pdf-ops 퍼징 356쪽 중 1쪽). pdf-ops 는 실제 도착대로 에뮬레이션하므로 그 글자는 `unmatched` 가 될 수 있다.
- 퍼징 측정(2026-10-19, pdf-ops 무작위 콘텐츠 356쪽, 이 규칙 기준): 실패 23쪽 = 같은 위치·같은 글자 덧그림(구조적 한계) 18쪽, pdf-ops 타일링 패턴 색 텍스트 타일 수 근사 4쪽, BT 안 Q 1쪽. 실제 문서 빈도는 M1 통합 후 코퍼스로 측정한다(`docs/m1-pdf-ops.md` 4절).

채택하지 않은 안: core 안 A(클립 콜백 미계수 — 보이는 패턴 색 텍스트가 텍스트 층에서 빠짐), core 안 B'(BT 안 경로 칠하기·ignoreText 재전송·Tr 7 순서에서 어긋남).

## 4. 타입(packages/shared-types/src)

| 파일 | 내용 |
|---|---|
| `geometry.ts` | Rect·Point·Quad(MuPDF 순서 ul, ur, ll, lr)·Matrix·RGB·ByteRange |
| `page-model.ts` | PageModel(fonts·chars·lines·blocks·paths·images·shades·glyphCount·paintCount·warnings), CharInfo(glyphSeq·text·gid·fontId·size·origin·quad·color·render·clip·wmode·line), LineInfo(bbox·wmode·dir·block·chars·spaceAfter), PaintColor(원래 색공간 + sRGB 근사), PathSegment, ExtractRequest |
| `source-map.ts` | SourceMap·SourceOp(kind·stream·range·formPath·ctm·clipDepth·mcids·optionalContent·text·glyphSeq·paintSeq·limits)·TextShowInfo·SourceGlyph(code·byteRange·origin·seq)·FormStep·ContentStreamRef/Info·EDIT_LIMIT_REASONS·PageLinkage·LinkStats |
| `search.ts` | SearchRequest(query·caseSensitive·startPage·pageLimit·maxHits)·SearchHit(pageIndex·quads)·SearchResult |
| `save.ts` | SaveMethod·ChangeKind·HeapLevel·SaveHeapEstimate(pdf-ops HeapEstimate 와 같은 모양)·SavePlan·SaveRequest·SaveResult(+heap) |
| `rpc.ts` | OpenResult(+inputMode)·PageInfo·RenderRequest·RenderedPage·PdfWorkerApi(open·getPageInfo·renderPage·extractPage·getSourceMap·linkPage·searchText·planSave·save·close) |

읽기 텍스트 조립 규칙(수정 5, 2026-10-19). 텍스트 선택 층 복사와 M1 완료 기준 "복사 = 추출 텍스트" 의 기준이다.

- 줄은 `PageModel.lines` 순서, 줄 안은 `LineInfo.chars` 순서로 각 `CharInfo.text` 를 잇는다.
- `LineInfo.spaceAfter` 의 각 k 위치(`chars[k]` 뒤)에 공백 하나를 넣는다. core 는 구조화 텍스트의 공백 중 Device 글리프와 짝이 없는 것을 여기에 담는다(TJ 간격으로 단어를 나눈 LaTeX 등 문서에서 공백이 빠지지 않게 하기 위함, `docs/m1-core.md` 7.1).
- 같은 블록의 줄 사이 "\n", 블록 사이 "\n\n". 줄에 속하지 않은 글자(`line` -1)는 뷰어 재량으로 뒤에 붙인다.
- 완료 기준 비교는 공백류를 접어서 한다(연속 공백·줄바꿈 → 공백 하나).

계약 커밋에 같이 넣은 연결부

- pdf-ops `source-map.ts`: `buildSourceMap(doc, pageIndex, options)`·`linkPage(model, map, options)` 시그니처 고정, 본문은 "M1 미구현" 예외.
- core: 새 RPC 연결. `getPageInfo`·`planSave`·`SaveResult.heap`·`OpenResult.inputMode`('buffer') 는 구현 완료. `extractPage`·`searchText` 는 "M1 미구현" 예외, `getSourceMap`·`linkPage` 는 pdf-ops 함수 호출.
- `packages/viewer-ui`: 뼈대(Preact 10.29.8, TSX 는 `jsxImportSource: preact`, tsc 빌드). `apps/extension` 이 의존한다. ESLint 브라우저 전역 추가.

## 5. 작업 분할(패키지별 세션, 각자 worktree)

공통 규칙

- worktree: `git -C /mnt/nas4/kjune/pdf-editor worktree add /mnt/nas4/kjune/pdf-editor-m1-<작업> -b m1-<작업> m1` 후 그 폴더에서 `pnpm install --frozen-lockfile`.
- 허용 파일 밖을 바꿔야 하면(특히 shared-types·lockfile·다른 패키지) 멈추고 메인 세션에 보고한다. 새 의존성이 필요해도 같다.
- 단계별 커밋, 커밋 메시지에 Claude 공동 저자 표기 금지, 원격 푸시 금지.
- 완료 기준 공통: 그 worktree 에서 `pnpm exec turbo run build typecheck test --force`, `pnpm lint`, 추적 파일 Prettier 통과. 결과는 `docs/m1-<작업>.md` 에 날짜·실측 표기로 남긴다.

### 5.1 pdf-ops: 콘텐츠 스트림 인터프리터·원본 연결 정보·매칭

| 항목 | 내용 |
|---|---|
| 담당 모델 | Opus 설계·리뷰 + Sonnet 구현(PLAN.md 10절) |
| 허용 파일 | `packages/pdf-ops/**`, `docs/m1-pdf-ops.md` |
| 구현 | `buildSourceMap`: 기존 토크나이저(`content-stream.ts`)를 그래픽·텍스트 상태 머신으로 확장. /Contents 배열 다중 스트림, Form XObject 재귀(기존 `xobject.ts` 사용 위치 색인과 일치), q/Q·cm·Tm/Td/TD/T*·Tc/Tw/Tz/TL/Ts/Tr, TJ 조정값, 글리프 원점 계산(Type0 /W·/DW, 단순 폰트 /Widths·/FirstChar, Type3 /FontMatrix, 폭 정보 없는 표준 14 폰트는 MuPDF 내장 폰트 `advanceGlyph`), marked content·/OC, 인라인 이미지, 연산별 `limits`(L1–L7·폰트 사유). `linkPage`: 3절 규칙 |
| 테스트 | 합성 PDF: 다중 /Contents, 중첩 Form, TJ 조정, Tc/Tw/Tz/Ts, Tr 0–7, 인라인 이미지, 꺼진 /OC, Type3, 스트림 경계에 걸친 연산. `fixtures/m0` 문서 매칭률. PageModel 은 core 에 의존하지 않도록 테스트 전용 최소 Device 헬퍼로 만든다(내보내지 않음) |
| 보고 | V1–V5 확인 결과, 매칭률, 실패 유형 |

### 5.2 core: 추출 모델·검색·Stream 입력

| 항목 | 내용 |
|---|---|
| 담당 모델 | Sonnet 구현, 설계 판단은 Opus |
| 허용 파일 | `packages/core/**`, `docs/m1-core.md` |
| 구현 | `extractPage`: 사용자 정의 Device(`runPageContents`, 항등 행렬)로 glyphSeq·gid·trm·폰트·렌더 방식·클립·도형·이미지·셰이드·paintSeq 수집, 3절 중복 제거 규칙. 구조화 텍스트 순회로 quad·색·줄·블록 수집 후 원점·유니코드로 결합. 구조화 텍스트에 없는 글자는 quad 근사 + `line` -1 + 경고. 색은 원래 색공간 값과 sRGB 근사. `searchText`: MuPDF 검색, 대소문자 옵션, 시작 페이지부터 순환, maxHits·truncated. Stream 입력 전환(A3-1): `new mupdf.Stream` 으로 보관 중인 원본 바이트를 읽어 열기, `inputMode` 'stream', `planSave` 는 `STREAM_INPUT_PEAK_HEAP_RATIO`. 페이지 단위 캐시(문서 변경 시 무효화) |
| 테스트 | 합성 PDF 로 glyphSeq 규칙(Tr 0–7 포함), quad·원점, 색공간, 경로 세그먼트, 이미지·셰이드, 검색(대소문자·순환·truncated), Stream 입력 저장 결과가 Buffer 입력과 바이트 동일 |
| 보고 | V1·V3 확인 결과, 추출 시간·메모리, 근사 사용 빈도 |

### 5.3 viewer-ui: 텍스트 선택 층·Ctrl+F·디버그 오버레이

| 항목 | 내용 |
|---|---|
| 담당 모델 | Sonnet |
| 허용 파일 | `packages/viewer-ui/**`(의존성 추가 제외), `apps/extension/src/viewer/**`, `apps/extension/viewer.html`, `apps/extension/e2e/` 새 spec 파일, `docs/m1-viewer-ui.md` |
| 구현 | 최소 페이지 이동(이전·다음·페이지 번호), 캔버스 위 투명 텍스트 선택 층(PageModel 의 lines 순서·chars quad 로 배치, 선택 → 복사 = 읽기 순서 텍스트), Ctrl+F 가로채기·검색창·결과 수·이전/다음·quad 하이라이트·해당 페이지 이동, 디버그 오버레이 토글(글자 quad 를 매칭 여부로 색 구분, 연산 정보 표시) |
| 테스트 | 순수 함수 단위 테스트(quad → CSS 배치, 선택 텍스트 조립, 검색 탐색 상태). Playwright spec 은 작성하되, extractPage·searchText·linkPage 가 "M1 미구현" 인 동안은 사유를 단 `test.skip` 으로 두고 통합 시 메인 세션이 켠다 |
| 보고 | 구현 범위, 통합 시 켤 테스트 목록 |

## 6. 통합 순서

1. 세 작업 브랜치(`m1-pdf-ops`, `m1-core`, `m1-viewer-ui`)를 메인 세션이 사용자 승인 후 `m1` 에 머지한다.
2. 통합 테스트: core `linkPage` 실연결, viewer Playwright spec 활성화, `fixtures/m0` 매칭률.
3. 코퍼스 회귀 하네스(M0 마무리 작업의 `fixtures/corpus` 사용): 문서별 매칭 실패율·실패 유형 측정. 별도 작업으로 나눈다.
4. 마일스톤 리뷰(구현 맥락과 분리한 읽기 전용 세션) → 사용자 승인 후 `m1` 을 `main` 에 머지.

## 7. 계약 변경 절차

- 작업 세션은 계약 불일치를 발견하면 구현을 멈추고 근거(재현 코드·수치)와 제안을 메인 세션에 보고한다.
- 메인 세션이 `m1` 에서 계약을 고치고 커밋한 뒤, 각 작업 브랜치가 `m1` 을 머지해 따라간다.
