# M1 계약: 추출 모델 · 원본 연결 정보 · 매칭 · 검색 · RPC

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-19 |
| 범위 | PLAN.md 6절 M1(추출·원본 연결) 병렬 구현의 공통 기준 |
| 기준 | `m1` 브랜치의 계약 커밋(이 문서와 `packages/shared-types/src` 를 포함한 커밋). 모든 M1 작업은 이 커밋에서 시작한다 |
| 변경 권한 | `packages/shared-types`, 루트 설정(eslint·tsconfig.base·turbo·pnpm-workspace), `pnpm-lock.yaml` 은 메인 세션만 바꾼다(PLAN.md 10절) |
| 제외 | DocumentModel(M2), EditOp·EditPlan(M3)은 각 마일스톤 시작 시 같은 방식으로 추가한다 |

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
| glyphSeq | 텍스트 콜백(fillText·strokeText·clipText·clipStrokeText·ignoreText)의 글리프 | 글리프마다 1. 같은 텍스트 객체(포인터 동일)를 연속으로 받은 fill/stroke/clip 콜백은 한 번으로 센다(Tr 2·4·5·6) |
| paintSeq | 텍스트 외 그리기 콜백(fillPath·strokePath·clipPath·clipStrokePath·fillShade·fillImage·fillImageMask·clipImageMask) | 콜백마다 1. 채움+선(B·B*·b·b*)은 2 |

- core 는 `runPageContents`(주석 제외)를 항등 행렬로 실행해 센다. pdf-ops 인터프리터는 같은 규칙으로 센다.
- 매칭(`linkPage`): 같은 번호끼리 짝짓고, 원점 오차가 `originTolerance`(기본 1pt) 이하인지 확인한다. 번호가 어긋난 구간은 원점으로 재동기화를 시도하고, 실패한 글자·도형은 -1 과 `unmatched` 제한으로 남긴다. 총수 차이는 `LinkStats` 에 기록한다.

검증 전제(어긋나면 해당 작업이 즉시 메인 세션에 보고한다. 계약을 임의로 바꾸지 않는다)

| # | 전제 | 확인 담당 |
|---|---|---|
| V1 | `runPageContents` 의 Device 콜백은 Form XObject 재귀를 포함해 콘텐츠 실행 순서로 온다 | pdf-ops, core |
| V2 | MuPDF 는 여러 Tj/TJ 를 한 텍스트 콜백으로 묶을 수 있으나 글리프 순서는 보존한다 | pdf-ops |
| V3 | 모든 표시 글리프가 위 규칙으로 정확히 한 번 센다(Tr 3 은 ignoreText, Tr 7 은 clipText). 포인터 동일 판정이 Tr 2·4–6 중복을 제거한다 | core, pdf-ops |
| V4 | 채움+선 연산은 fillPath → strokePath 콜백 2개다 | pdf-ops |
| V5 | 꺼진 선택적 콘텐츠(/OC)는 Device 에 오지 않는다. pdf-ops 는 해당 글리프 `seq` 를 null 로 두고 `optional-content` 제한을 단다 | pdf-ops |

## 4. 타입(packages/shared-types/src)

| 파일 | 내용 |
|---|---|
| `geometry.ts` | Rect·Point·Quad(MuPDF 순서 ul, ur, ll, lr)·Matrix·RGB·ByteRange |
| `page-model.ts` | PageModel(fonts·chars·lines·blocks·paths·images·shades·glyphCount·paintCount·warnings), CharInfo(glyphSeq·text·gid·fontId·size·origin·quad·color·render·clip·wmode·line), PaintColor(원래 색공간 + sRGB 근사), PathSegment, ExtractRequest |
| `source-map.ts` | SourceMap·SourceOp(kind·stream·range·formPath·ctm·clipDepth·mcids·optionalContent·text·glyphSeq·paintSeq·limits)·TextShowInfo·SourceGlyph(code·byteRange·origin·seq)·FormStep·ContentStreamRef/Info·EDIT_LIMIT_REASONS·PageLinkage·LinkStats |
| `search.ts` | SearchRequest(query·caseSensitive·startPage·pageLimit·maxHits)·SearchHit(pageIndex·quads)·SearchResult |
| `save.ts` | SaveMethod·ChangeKind·HeapLevel·SaveHeapEstimate(pdf-ops HeapEstimate 와 같은 모양)·SavePlan·SaveRequest·SaveResult(+heap) |
| `rpc.ts` | OpenResult(+inputMode)·PageInfo·RenderRequest·RenderedPage·PdfWorkerApi(open·getPageInfo·renderPage·extractPage·getSourceMap·linkPage·searchText·planSave·save·close) |

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
