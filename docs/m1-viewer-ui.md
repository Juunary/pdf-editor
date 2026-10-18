# M1 viewer-ui: 페이지 이동 · 텍스트 선택 층 · Ctrl+F · 디버그 오버레이

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-19 (같은 날 계약 수정 1~5 병합 후 `LineInfo.spaceAfter` 반영) |
| 범위 | `docs/m1-contract.md` 5.3절 (PLAN.md 6절 M1 "텍스트 선택 층·Ctrl+F" + 디버그 오버레이) |
| 브랜치 | `m1-viewer-ui` (기준: 계약 커밋 `97a6fb4`, 이후 `m1` 계약 수정 5 `e276809` 까지 병합) |
| 상태 | **구현·합성 데이터 검증 완료. 실제 `extractPage`·`searchText`·`linkPage` 연동 검증은 통합 후** |
| 변경 범위 | 허용 파일만 변경. `shared-types`·`core`·`pdf-ops`·`pnpm-lock.yaml`·루트 설정·manifest 무변경, 새 의존성 없음 |

## 1. 구현 범위

| 기능 | 상태 | 구현 위치 |
|---|---|---|
| 최소 페이지 이동(이전·다음·번호 입력) | 완료 | `components/Controls.tsx`, `page-nav.ts`, `controller.ts` |
| 투명 텍스트 선택 층(quad 배치, 드래그·더블/트리플클릭·Shift+클릭·Ctrl+A, Ctrl+C = 읽기 순서 텍스트) | 완료 | `components/TextLayer.tsx`, `reading-order.ts`, `text-layout.ts`, `selection-dom.ts`, `selection-rects.ts` |
| Ctrl+F 가로채기·검색창·결과 수·이전/다음·quad 하이라이트·해당 페이지 이동·현재 페이지부터 검색 | 완료 | `components/FindBar.tsx`, `components/HighlightLayer.tsx`, `search-nav.ts`, `controller.ts` |
| 디버그 오버레이(매칭 여부 색 구분, 요약 HUD, 마우스 위치 글자의 `SourceOp`) | 완료 | `components/DebugLayer.tsx`, `debug-info.ts` |
| "M1 미구현" 예외 시 해당 기능만 비활성화 + 진단 로그, 렌더·저장·페이지 이동 유지 | 완료 | `controller.ts`, `failure.ts` |
| 확장 뷰어 연동(기존 렌더·저장·MIME handler 흐름 유지) | 완료 | `apps/extension/src/viewer/main.ts`, `viewer.html`, `viewer.css` |
| 확대·dpr 반영, 창 크기·브라우저 확대 변화 시 재렌더 | 완료 | `layout.ts`, `controller.ts`(`refreshEnvironment`), `mount.tsx` |

### 1.1 동작 규칙

- **읽기 순서**: `PageModel.lines` 배열 순서, 줄 안은 `LineInfo.chars` 순서입니다. 줄이 참조하지 않는 글자(`line` = -1 포함)는 뒤에 따로 모아 글리프 순서·기준선 위치로 줄을 만듭니다(OCR 숨김 텍스트 대비, 휴리스틱).
- **복사 텍스트 조립**(`docs/m1-contract.md` 4절 규칙): 줄 안 `chars` 의 `text` 를 잇고, `LineInfo.spaceAfter` 의 k 위치(`chars[k]` 뒤)에 공백 하나를 넣습니다. 같은 블록 안 줄 사이 `"\n"`, 블록 사이 `"\n\n"`. 합성 공백은 **양옆 글자가 모두 선택 구간에 있을 때만** 들어가며(경계에서는 앞뒤 공백 없음), **줄 끝 합성 공백은 표시하지 않습니다**(바로 줄바꿈이 오므로 공백류를 접으면 같음). 줄 밖 글자(orphan)는 뒤에 붙이고 합성 공백이 없습니다.
- **합성 공백의 표현**: 글자(`ReadingItem`)가 아니므로 캐럿 위치·선택 구간·포인터 판정에는 들어가지 않고 글자의 `spaceAfter` 플래그로만 둡니다. 더블클릭 단어 구간은 합성 공백에서 끊깁니다. 텍스트 층 DOM 에는 글자 span 과 구분되는 `span[data-space]` 를 글자 오른쪽 끝에 폭 없이 추가해, 브라우저 기본 복사·드래그에서도 단어가 붙지 않고 `.pe-line` 의 `textContent` 가 조립 텍스트와 같아지게 합니다. 선택 하이라이트는 줄 단위 상자라 공백 자리를 포함해 이어집니다.
- **글자 배치**: 글자마다 `span` 하나. `left/top` = quad 의 ul × CSS 배율, 회전은 `rotate()`, 폭은 canvas `measureText` 로 잰 자연 폭에 맞춘 `scaleX()`. 캔버스 비트맵은 `cssScale × devicePixelRatio`, 표시 크기는 비트맵 ÷ dpr 이므로 오버레이는 CSS 배율만 씁니다.
- **선택 판정**: 포인터 위치에서 가장 가까운 글자(가중 거리, 줄 진행 방향 0.25배)와 글자 앞/뒤 절반으로 캐럿을 정하고, 결과만 DOM Selection 에 반영합니다. 복사는 `copy` 이벤트에서 선택 구간을 읽기 순서 텍스트로 조립해 `text/plain` 에 넣습니다. 선택 영역의 화면 표시는 줄마다 상자 하나를 직접 그립니다.
- **검색**: 입력 200 ms 후(Enter 는 즉시) 현재 페이지를 `startPage` 로 `searchText` 호출. 0번 결과 = 현재 페이지에서 처음 만나는 결과. 이전/다음은 결과 목록 순환, 다른 페이지 결과이면 그 페이지로 이동. 진행 중 검색이 있으면 최신 질의 하나만 대기시키고, 오래된 응답은 버립니다. 한글 IME 조합 중 Enter 는 이동에 쓰지 않습니다.
- **기능 격리**: 오류 메시지에 "미구현"이 있으면 해당 기능을 영구 비활성화(`state.disabled`)하고 `diag` 에 한 번만 기록합니다. 그 밖의 오류는 그 호출만 실패로 두고 다음 페이지·입력에서 다시 시도합니다. 검색이 비활성화되면 Ctrl+F 를 가로채지 않아 Chrome 기본 찾기로 넘어갑니다. 첫 페이지 렌더 실패는 기존처럼 열기 실패로 처리합니다(MIME handler 는 Chrome 기본 뷰어로 폴백).
- **진단 이벤트**: `render`(기존 필드 유지), `extract-unavailable`, `extract-error`, `search-unavailable`, `search-error`, `link-unavailable`, `link-error`, `render-error`, `paint-error`.

### 1.2 설계 결정과 근거

| 결정 | 근거(2026-10-19 실측) |
|---|---|
| 브라우저 기본 드래그 선택을 쓰지 않고 캐럿을 직접 판정 | 글자 span 을 절대 배치한 층에서 Chromium 156 기본 드래그 선택(2줄 합성 페이지 실험): 한 줄 안·글자 위 이동은 정상이나, **줄 끝 오른쪽 빈 곳으로 끌면 선택이 줄 시작으로 튐**(`"Hel"`). pdf.js 방식 `endOfContent` 를 넣으면 같은 위치에서 **다음 줄 전체까지 선택**되고, 줄 왼쪽 빈 곳에서 시작하면 뒤쪽 일부(`"nd line"`)만 선택됨 → 기본 동작으로는 일관된 결과를 만들 수 없음 |
| 선택 영역 표시를 직접 그림(`::selection` 투명) | 글자마다 블록이라 Chrome 이 블록마다 줄바꿈 표식 영역을 덧칠해 하이라이트가 줄무늬로 겹침(스크린샷 확인). 복사·접근성은 DOM Selection 그대로 |
| 컨트롤러를 DOM 비의존 클래스로 분리 | 가짜 `ViewerHost` 로 Node 단위 테스트(비동기 경합·기능 격리). DOM 테스트 환경(jsdom 등) 의존성 없이 해결 |
| 컨트롤 루트와 페이지 루트를 따로 마운트 | 툴바(고정 HTML)와 페이지 영역이 문서상 떨어져 있어 한 컴포넌트 트리로 묶기 어려움. 같은 컨트롤러를 두 루트가 구독 |
| 응답 stale 판정: 렌더·검색은 요청 토큰, 추출 모델은 페이지 기준 | 추출 모델은 배율과 무관하므로 창 크기 변화 재렌더 중에도 재사용 |

## 2. 검증 결과 (2026-10-19, 이 worktree)

| 항목 | 결과 |
|---|---|
| `pnpm exec turbo run build typecheck test test:e2e --force` | 통과 (19 tasks). 단위 테스트: viewer-ui 9 파일 **116건**, extension 21건, core 7건, pdf-ops 33건, shared-types 1건, spike 21건(1 skip, 기존) |
| `pnpm lint` | 통과 |
| `pnpm format:check` (`prettier --check .`) | 통과 |
| e2e `extension.spec.ts` (기존) | 통과(1건, 변경 없음) |
| e2e `viewer-ui.spec.ts` (신규) | **20건 통과, 6건 skip**(아래 3절). 반복 실행에서 실패·불안정 없음 |

신규 e2e 내용(실제 Chromium 에서 합성 PageModel·가짜 호스트로 viewer-ui 빌드 산출물 구동):

- 텍스트 층: 글자 span 상자 = quad × 배율(35자 전수, 허용 오차 0.75 CSS px), DOM 순서 = 읽기 순서, 글자 투명, dpr 2 에서 비트맵 dpr 배·오버레이 CSS px 유지
- 합성 공백: `spaceAfter` 줄의 복사(전체·드래그 경계·더블클릭), DOM 줄 텍스트, 하이라이트 연속
- 선택·복사: 줄 사이 드래그, 블록 경계(빈 줄), 줄 끝 바깥·줄 사이·텍스트 아래로 끌기, 거꾸로 끌기, 더블/트리플클릭, Ctrl+A, 선택 하이라이트 상자 위치, 실제 클립보드 기록
- 페이지 이동: 이전·다음·번호 입력, 잘못된 입력 되돌림
- Ctrl+F: 포커스, 결과 수, 하이라이트 위치 = quad × 배율(`data-quad` 일치), Enter·Shift+Enter 순환과 페이지 이동, 현재 페이지부터 검색, 대소문자 옵션, 결과 없음, Esc, 화면 밖 결과 스크롤
- 디버그: 색 구분(픽셀 확인), 매칭/제한/실패 개수, 호버 시 연산·스트림·범위·제한 표시, 선택과 공존
- 기능 격리: 추출·검색·링크 각각 "M1 미구현" 일 때 해당 기능만 비활성화, 진단 로그 1회, Ctrl+F 가로채기 중단
- 확장 연동: 실제 확장에서 `extractPage` 미구현 시 텍스트 층 없음·진단 기록·렌더·저장 버튼 유지

성능(11,000자 페이지, 서버 헤드리스 Chromium 156, 1회 측정 — e2e 에는 허용 상한으로만 고정): 텍스트 층 준비 약 0.42–0.49 s(페이지 로드 포함), Ctrl+A 복사 약 0.14 s, 드래그 1회 이동당 판정 ≤ 1.3 ms·선택 반영 ≤ 9 ms·하이라이트 갱신 ≤ 2.5 ms. 실제 문서·Windows 기기 수치는 미측정입니다.

## 3. 통합 시 켤 테스트 목록

`m1-core`(`extractPage`·`searchText`)와 `m1-pdf-ops`(`linkPage`·`getSourceMap`) 머지 후 `apps/extension/e2e/viewer-ui.spec.ts` 의 `test.skip(` 를 `test(` 로 바꿉니다. 문서는 `public/diag` 의 `m0-sample.pdf`(영문 1쪽), `m0-spike-saved.pdf`(한글 포함).

| # | 테스트 | 켜는 조건 | 기대값과 근거 | 조정 가능성 |
|---|---|---|---|---|
| 1 | 선택→복사: Ctrl+A 복사 결과가 `m0-sample.pdf` 추출 텍스트와 일치 | `extractPage` | `pdftotext` 로 확인한 본문과 비교(공백류를 접어서 비교, 계약 4절) | core 가 채우는 `spaceAfter` 로 단어 사이 공백이 빠지지 않는지 이 테스트가 확인 |
| 2 | 선택→복사: 첫 두 줄 드래그 복사가 DOM 줄 순서와 일치 | `extractPage` | DOM 줄 텍스트(합성 공백 포함) + `"\n"` | 블록 구분자 정책 변경 시 |
| 3 | 선택→복사: MIME handler 최상위 문맥에서 동일 결과 | `extractPage` | 1번과 같은 본문 | 임베디드 문맥(`<embed>`·`<iframe>`·`<object>`)은 이 테스트에 추가하는 것을 권장 |
| 4 | Ctrl+F: `paragraph` 5건, 하이라이트 상자 안 글자 = 검색어, Enter 순환, Esc | `searchText` + `extractPage` | `m0-sample.pdf` 대소문자 무시 5건(제목 1·본문 4) | `searchText` 의 quad 가 줄 단위로 나뉘면 하이라이트 개수 기대값 조정 |
| 5 | Ctrl+F: 한글 `검색과 복사` 1건 | `searchText` + `extractPage` | `docs/m0-day1-log.md` 6.2절 재열기 검색 결과(`검색과 복사` 1건) | — |
| 6 | 디버그 오버레이: 색 구분·툴팁 | `linkPage`·`getSourceMap` + `extractPage` | `m0-sample.pdf` 매칭 실패 0, 툴팁에 연산·범위·제한 | **실측 후 기준 조정**(매칭률 기준은 M1 매칭 실패율 측정 결과에 따라) |

켜지 않는 테스트: 확장 연동 `extractPage 가 "M1 미구현" 인 동안 …` 는 `extractPage` 가 구현되면 스스로 skip 합니다(`test.skip(true, …)` 동적 판정). 통합 후 삭제해도 됩니다. 하니스 테스트(19건)는 계속 유지합니다(합성 데이터로 UI 회귀를 막는 용도).

테스트 작성용 DOM 식별자: `#pe-page`(`data-page-index`, `data-css-scale`), `#page-canvas`, `#pe-text-layer`(`data-chars`, `data-orphan-chars`) > `.pe-line` > `span[data-i]`, `#pe-selection .pe-sel`, `#pe-highlights .pe-hl`(`data-hit`, `data-current`, `data-quad`), `#pe-find-*`, `#pe-debug-canvas`(`data-matched`·`data-limited`·`data-unmatched`), `#pe-debug-hud`, `#pe-debug-tip`.

## 4. 통합 시 점검 항목

- **복사 규칙**: 계약 4절 "읽기 텍스트 조립 규칙"(줄 `\n`, 블록 `\n\n`, `spaceAfter` 공백)으로 확정되어 정렬 점검은 끝났습니다. 남은 확인은 실제 core 의 `spaceAfter` 값으로 LaTeX 류 문서(공백 글리프 없음)의 복사에 공백이 들어가는지입니다.
- **실제 quad 정렬**: 합성 PageModel 로는 글자 span·하이라이트·디버그 quad 가 quad × 배율과 일치함을 확인했습니다. 실제 core 의 quad(합자·근사 quad·회전·세로쓰기)로도 일치하는지 확인이 필요합니다.
- **줄 밖 글자(orphan)**: 구조화 텍스트에 없는 글자는 뒤에 모아 휴리스틱으로 줄을 만듭니다. 실제 문서에서 발생 빈도(텍스트 층 `data-orphan-chars`)를 측정해 규칙을 확정해야 합니다.
- **디버그 이중 호출**: 디버그를 켜면 `linkPage` 와 `getSourceMap` 를 병렬로 부릅니다. core 가 `buildSourceMap` 을 각각 실행하면 비용이 2배이므로 캐시 여부를 확인해야 합니다.
- **검색 응답 시간**: `searchText` 는 문서 전체(기본 1000건 상한)를 한 번에 요청합니다. 대형 문서에서의 응답 시간은 core 구현 후 측정해야 합니다.

## 5. 남은 제한 (2026-10-19 기준)

| # | 제한 | 영향 |
|---|---|---|
| 1 | 실제 `PageModel`·`SearchResult`·`PageLinkage` 로 검증하지 않음(합성 데이터만) | 통합 시 3·4절 점검 필요 |
| 2 | 공백 글리프 없이 간격으로만 단어를 나눈 PDF 의 공백은 core 가 채우는 `LineInfo.spaceAfter` 에 의존(계약 수정 5). 뷰어는 글자 간격으로 공백을 추정하지 않음. 줄 끝 합성 공백은 표시하지 않음 | 합성 데이터로만 검증, 실제 core 값은 통합 후 확인 |
| 3 | 단일 페이지 보기만 지원(연속 스크롤·썸네일 없음). 배율은 화면 폭 맞춤(최대 1.5배)이며 확대/축소 UI 없음(브라우저 확대는 창 크기 변화로 재렌더) | 사용성 |
| 4 | 드래그 중 자동 스크롤, 키보드 선택(Shift+방향키), 터치 선택 미지원 | 긴 페이지에서 화면 밖까지 선택 불가 |
| 5 | 세로쓰기·회전 글자는 단위 테스트(좌표·캐럿)와 회전 상자 변환만 검증, 실제 렌더 미확인 | 해당 문서에서 오차 가능 |
| 6 | Chrome 의 최소 글자 크기 설정이 켜진 환경에서 작은 글자 span 폭이 어긋날 수 있음(글자는 투명이고 선택 영역은 직접 그리므로 복사·하이라이트에는 영향 없음, 포인터 판정은 모델 quad 기준) | 영향 없음 예상, 미확인 |
| 7 | 한글 IME 조합 중 Enter 처리는 코드(`isComposing`)로만 처리, 실제 IME 입력 e2e 미검증 | Windows 수동 확인 필요 |
| 8 | 임베디드 MIME handler 문맥(`<embed>`·`<iframe>`·`<object>`)과 Windows 실제 Chrome 에서 Ctrl+F 가로채기·복사 미검증(서버 Chromium 156 만) | 사용자 Windows 확인 필요 |
| 9 | 디버그 오버레이는 글자만 표시(도형·이미지·셰이드 매칭 미표시), 요약 HUD 는 통계만 | 도형 매칭 확인은 `linkPage` 통계로 |
| 10 | 검색 옵션은 대소문자만(전체 단어·정규식 없음). 결과 1000건 초과 시 `+` 표기만 | — |
| 11 | 편집 UI 없음(M3 범위) | — |

## 6. Action Item

| # | 내용 | 담당 |
|---|---|---|
| 1 | `m1-core`·`m1-pdf-ops`·`m1-viewer-ui` 머지 후 3절 테스트 6건 활성화, 실패 시 기준값 조정 | 메인 세션 |
| 2 | 4절 점검 항목(실제 `spaceAfter` 복사, 실제 quad 정렬, orphan 빈도, 디버그 이중 호출, 검색 응답 시간) 확인 | 메인 세션 |
| 3 | Windows Chrome 수동 확인: 일반·MIME handler(최상위·임베디드) 문맥에서 Ctrl+F·드래그 선택·Ctrl+C, 한글 IME 로 검색어 입력 | 사용자 |
| 4 | 확장 뷰어의 알려진 한계(`docs/m0-day1-log.md` 9.5절) 해소 여부는 위 1·3 결과로 판정, PLAN.md 반영은 메인 세션 | 메인 세션 |

## 7. 변경 파일

- `packages/viewer-ui/src/`: `layout.ts`, `reading-order.ts`, `text-layout.ts`, `selection-dom.ts`, `selection-rects.ts`, `text-measure.ts`, `page-nav.ts`, `search-nav.ts`, `debug-info.ts`, `failure.ts`, `shortcuts.ts`, `viewer-host.ts`, `controller.ts`, `hooks.ts`, `mount.tsx`, `style.css`, `components/*.tsx`(Controls·FindBar·PageSurface·TextLayer·SelectionOverlay·HighlightLayer·DebugLayer), `index.ts`
- `packages/viewer-ui/test/`: 단위 테스트 9 파일, `fixtures.ts`(합성 PageModel, `spaceAfter` 지원, e2e 하니스와 공유)
- `packages/viewer-ui/package.json`: `exports` 에 `./style.css`, `files` 에 `src/style.css` 추가(의존성 변경 없음)
- `apps/extension/src/viewer/main.ts`(렌더·상태·저장 활성화 연동), `viewer.css`(툴바 `z-index`), `viewer.html`(컨트롤 마운트 지점, 캔버스는 UI 가 생성)
- `apps/extension/e2e/viewer-ui.spec.ts`(신규)
