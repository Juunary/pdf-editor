# M3 통합 결과

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-20 |
| 범위 | `docs/m3-contract.md` 7절 통합 순서 1–3(머지·통합 시험·코퍼스 측정). 마일스톤 리뷰(4)·Windows 사용자 확인(5)은 아래 7절 |
| 기준 | `m3` 브랜치. 계약 cae2045·f17036e, 계약 수정 1–4(cf07d24·b07c295·927cfde·bec0225) |
| 측정 환경 | 서버 `sailab01`, Node 22.18, npm `mupdf` 1.28.1, pdfjs-dist 6.4.299, Poppler 22.02, Playwright 1.64.1 번들 Chromium 156. Windows Chrome 은 미측정 |

## 1. 머지

| 순서 | 브랜치 | 머지 커밋 | 작업 문서 |
| --- | --- | --- | --- |
| 1 | `m3-pdf-ops`(S1) | b69cdfc | `docs/m3-pdf-ops.md` |
| 2 | `m3-reflow`(S2) | a9f74ac | `docs/m3-reflow.md` |
| 3 | `m3-core`(S3) | f4ce336 | `docs/m3-core.md` |
| 4 | `m3-viewer-ui`(S4) | dd160ae | `docs/m3-viewer-ui.md` |
| 5 | `m3-layout`(S5) | 795a798 | `docs/m2-accuracy.md` 7.2·7.3 |

- 다섯 브랜치는 서로 다른 파일만 바꿔 충돌이 없었다. 커밋 작성자는 모두 Juunary 이고 AI 공동 저자 표기는 0건이다.

## 2. 통합 보완(1cc19a7 외)

| 항목 | 내용 |
| --- | --- |
| 실제 어댑터 통합 시험 | `packages/core/test/edit-real.test.ts` 4건. 실제 pdf-ops·reflow 로 판정 → 시작 → 갱신 → 커밋. 확인 항목: 원래 자리 삽입(제목 < 새 문단 < 둘째 문단), 폴백 경고, undo/redo, 폴백 초안 취소 뒤 새 편집 → 저장, 저장 파일의 폴백 서브셋·Info, 재열기 새 세션의 같은 블록 재편집(`rewrite-block`), 재적용 결과 = 원래 편집(텍스트, 저장 파일 렌더·텍스트) |
| RPC(계약 수정 4) | `beginParagraphEdit` 선택 인자 `renderScale`, `listRedactAnnots`(core·Worker·뷰어 복구 래퍼) |
| 통합 e2e | `apps/extension/e2e/edit-integration.spec.ts` 4건 활성화: DoD 흐름(한글 조합 → 커밋 → 저장 → 재열기 → 텍스트 → 같은 문단 재편집), 반응 시간 스모크, 폴백 경고, Worker 치명 오류 복구. 4회 반복 16/16 통과 |
| 회귀 수정(뷰어) | 최상위 MIME handler 문맥에서 열자마자 누른 Ctrl+A·Ctrl+C 가 빈 결과(M1 e2e 6/6 실패). `controller.start()` 가 편집 판정(폴백 폰트 적재 포함)까지 기다려 포커스가 약 1.5초 늦어졌다. 열기 전에 포커스를 가져오도록 고침(5/5 통과) |
| 회귀 수정(reflow) | 공백 없는 justify 줄은 이웃한 두 클러스터가 모두 CJK·한글일 때만 사이를 벌린다. 라틴 단어 하나뿐인 줄을 글자 사이로 벌리면 MuPDF 가 글자마다 공백을 넣어 추출·검색이 깨졌다(코퍼스 측정 jnl-jdis-2026-2-2-7 1쪽) |
| 시험 수정 | 편집기 표시 전 입력 경쟁, 같은 좌표 마우스로 테두리 미갱신, 복구 뒤 redo 기대(계약 D6 상 이력은 잃음), 커밋 시각(`/ModDate`)이 다른 저장 바이트 비교 |

## 3. 검증(2026-10-20, 강제 실행)

| 명령 | 결과 |
| --- | --- |
| `pnpm exec turbo run build typecheck test test:e2e --force` | 25개 작업 성공. 단위: pdf-ops 385·3 건너뜀, core 211·4(코퍼스 측정 opt-in 1건 추가), reflow 56, viewer-ui 227, extension 43, layout-recon 49·3, spike-m0 34, shared-types 2. e2e 85 통과·2 건너뜀(M1 동적 건너뜀, 반응 시간 측정 opt-in) |
| `pnpm lint`, `pnpm exec prettier --check .` | 통과 |

## 4. 코퍼스 편집 측정(계약 8.2·8.3)

재현:

```
EDIT_CORPUS_DIR=<코퍼스> NODE_OPTIONS=--max-old-space-size=12288 pnpm --filter @pdf-editor/core exec vitest run test/edit-corpus-dod.test.ts
```

- 표본: 24문서 × 쪽 2개(0·3쪽) = 48쪽, 편집 가능하고 20자 이상인 흐름 문단 110개 × 편집 3종(같은 텍스트, 라틴 문장, 원문 + 한글 문장) = 330편집, 오류 0.
- 편집 가능 비율(표본 쪽의 흐름 문단 전체, 표본 편향 보완): 496/557 = 89.1%. 첫 사유: `type3-font` 46, `insertion-clipped` 9, `vertical-or-rotated` 6.
- 판정 방식 선택: 지운 글리프 잉크 상자 = 원 문단 글자 quad 를 글자 크기 25% 넓힌 합집합. 라틴·한글 편집은 넘치면 `expand`. 렌더는 scale 2, 주석 제외.

| 지표(n = 330) | MuPDF | pdf.js | Poppler |
| --- | --- | --- | --- |
| 변경 허용 영역 밖 렌더 변화 0 | 330 | 330 | 330 |
| 다른 쪽 렌더 변화 0(MuPDF, 첫 5쪽) | 330 | – | – |
| 다른 쪽 객체 불변(첫 30쪽) | 330 | – | – |
| 새 글자 잉크 ≥ 1 px | 324 | 324 | 324 |
| 텍스트 일치(엄격: 블록 상자 안 글자 = 입력) | 228 | 239 | – |
| 텍스트 일치 또는 상자에 이웃 문단 글자가 겹침 | 327 | 329 | – |
| 검색(quad 중심이 새 글자 상자 안) | 327 | – | – |
| 읽기 순서 통과(전체) | 243 | 243 | – |

실패 분류(측정)

| 지표 | 분류 | 건수·예 |
| --- | --- | --- |
| 텍스트(엄격) | 넓힌 영역이 아래 문단과 겹쳐 "상자 안 글자" 판정에 이웃 문단 글자가 섞임(판정 방법 한계, 기대 텍스트는 연속으로 들어 있음) | MuPDF 99/102, pdf.js 90/91. 93편집에 `area-overlaps-content` 경고 |
| 텍스트·잉크 | `expand` 가 `areaLimit` 에 막혀 마지막 줄이 블록 BBox 에서 잘림(`overflow-clipped` 경고는 남) | fed-h41-current 1쪽 #2 한글, ustreas-mts-202509 1쪽 #0 |
| 잉크 | 흰 제목 글자가 다시 배치되며 붉은 띠 아래(흰 배경)로 넘어감 | zen-beamer-10545284 4쪽 #0(3종) |
| 잉크 | 표본 규칙("첫 구간 모양")이 흰색 글머리 번호 모양을 골라 새 텍스트 전체가 흰색 | zen-beamer-10545284 4쪽 #9 라틴·한글. 제품 쓰기 오류 아님 |
| 검색 | 라틴 단어 하나뿐인 justify 줄의 글자 간격(2절 reflow 수정 대상) | jnl-jdis-2026-2-2-7 1쪽 #4 라틴 |
| 검색 | 검색할 단어 없음(밑줄 문단, 자간 넓은 대문자) | 2건 |
| 읽기 순서 | 원본 추출도 같은 판정에서 실패(엔진 콘텐츠 순서 ≠ PageLayout) | 엔진마다 27 |
| 읽기 순서 | `reading-order-approximate` 경고가 붙은 편집(계약 1.1: 따로 셈) | 18(6문단 × 3) |
| 읽기 순서 | 고유 부분 문자열을 찾지 못함(판정 불가)·해당 없음 | 39·3 |
| 읽기 순서 | 경고 없고 원본 판정이 통과한 편집 중 실패 | **0**(두 엔진) |

- 시간(330편집): 시작 중앙값 20.4 ms·p95 49.1 ms, 갱신 중앙값 7.3 ms·p95 27.8 ms, 커밋 중앙값 0.7 ms, 저장 중앙값 53.8 ms·p95 424.7 ms·최대 561.6 ms. 저장 파일 중앙값 2.62 MB·최대 13.7 MB, `wasmHeapBytes` 최대 357 MB.
- reflow 수정 뒤 재측정: 5절.

## 5. reflow 수정 뒤 재측정

- 같은 하네스·같은 표본(330편집)으로 다시 실행(2026-10-20, 294.8 s).
- 검색 327 → **328**: jnl-jdis-2026-2-2-7 1쪽 #4 라틴이 통과했다.
- 나머지 지표는 모두 4절과 같다: 영역 밖 렌더, 다른 쪽, 객체, 잉크, 텍스트, 읽기 순서. 남은 검색 실패 2건은 검색할 단어가 없는 경우다.

## 6. 편집 반응 시간(계약 8.4)

재현: `EDIT_LATENCY_CORPUS_DIR=<코퍼스> pnpm exec playwright test e2e/edit-latency.spec.ts`(apps/extension).

- 모집단: 5문서 × 문단 2개 × 텍스트 3종(라틴 90자, 한글 30자, 숫자·한자 섞임 37자) = 키 입력 1,570회. 표지라 0쪽에 대상 문단이 없는 문서는 0–7쪽 중 처음으로 조건(50–500자 편집 가능 문단 2개)을 만족하는 쪽.
- 구간: 입력 이벤트 → 변경 영역 합성(`edit-session.ts` 의 `pe-edit-latency`). 서버 Chromium 156 headless, devicePixelRatio 1, cssScale 1.5.

| | p50 | p95 | 최대 |
| --- | --- | --- | --- |
| 전체(1회 / 2회) | 5.6 / 5.3 ms | 10.1 / 10.3 ms | 39.5 / 49.2 ms |
| core `updateMs` | 4.8 / 4.5 ms | 9.5 / 9.6 ms | 38.8 / 48.1 ms |

- 잠정 목표 p95 100 ms 를 만족한다(약 10배 여유). 최대값은 모두 문단의 첫 텍스트 첫 키 입력(core 첫 사용 비용)이고, 그것을 빼면 최대 약 14 ms.
- 목표치 고정은 사용자 확인 사항이다(계약 1.1). Windows 실제 PC 측정은 하지 않았다.

## 7. 남은 제한·확인

| # | 내용 | 처리 |
| --- | --- | --- |
| 1 | 같은 텍스트로 교체해도 원 bbox 를 넘는 문단 26/110. 확인한 원인 1개: TeX 덧쓰기 악센트(`´` 를 따로 전진하는 글리프로 배치해 줄이 넓어지고 악센트가 글자 위에 오지 않음, zen-beamer-10545284 4쪽 #0). 나머지 25개는 미진단 | 후속 조사(진단 후 reflow 또는 시작 상태 보정) |
| 2 | `expand` 가 `areaLimit` 에 막히면 마지막 줄이 BBox 에서 잘리고, 완전히 잘린 글자는 추출에서 빠진다(경고 `overflow-clipped` 는 표시) | **결정(2026-10-20 사용자)**: 현행 유지. `overflow-clipped` 경고를 보여 주고 사용자가 그대로 커밋할 수 있다 |
| 3 | 더블클릭 후 편집기가 열리는 동안(시작 RPC 처리 중) 입력한 글자는 버려진다 | 후속(입력 버퍼링). Windows 확인 항목에 포함 |
| 4 | 저장 직후 첫 undo 등 redo 소실 조건(계약 D9 수정 4), 복구 뒤 undo 이력 소실(D6) | 계약대로. 사용자 안내 문구 확인 |
| 5 | 마일스톤 리뷰(읽기 전용) | 다음 단계 |
| 6 | Windows 사용자 확인: MS 한글 IME 실제 입력·한자 변환·조합 중 클릭/Esc/Ctrl+Z, 임베디드 문맥 편집, 편집 문서 Ctrl+S 덮어쓰기(A10), 저장 파일 Acrobat 표시(설치 시) | 사용자 |
| 7 | 라벨 67쪽 사람 확인(M2) | 사용자 |

## 8. 리뷰 반영

마일스톤 리뷰(읽기 전용) 지적 4건. 모두 고친 코드 이전에는 실패하고 이후 통과하는 회귀 시험을 더했다.

| # | 지적 | 원인 | 수정 | 시험 |
| --- | --- | --- | --- | --- |
| H1 | ToUnicode 가 분해형(NFD, `é → e U+0301`)인 원문은 같은 텍스트 커밋에서도 악센트 글자를 잃음 | 역매핑 키는 NFC, 클러스터 조회·시작 상태 runs 는 정규화 없음. 결합 문자 하나가 없으면 클러스터 전체를 버림 | `font-assign.ts`: 조회를 NFC 키 → NFD 분해(기본 글자 + 결합 문자, 한글 자모 분해 제외) 순으로 시도. 기본 글자는 되고 결합 문자만 두 폰트에 없으면 기본 글자를 원본으로 쓰고 그 결합 문자만 `glyph-missing`. `edit-plan.ts` `normalizeStartState`: 시작 상태 runs 를 클러스터 단위 NFC 로 바꾸고 `charIndexOfOffset` 은 정규화한 위치마다 원래 클러스터의 첫 원본 글자. 블록 재편집 판정의 텍스트 비교도 NFC | core `edit-real.test.ts` "H1" 2건(NFD 문서 같은 텍스트 커밋: 경고 없음, 추출 = 입력(NFC 비교), 저장 파일 동일 / `q + U+0301`: 기본 글자 유지·결합 문자만 경고), pdf-ops `font-manager.test.ts` "H1" 1건 |
| M1 | 공백 클러스터만 폴백으로 가면 저장 때 폴백 전체 폰트(약 4 MB)가 들어가고 `font-embed` 가 변경 종류에 없음 | 폴백 사용을 `font-fallback` 경고 유무로 판단. 경고는 공백을 세지 않음 | `edit-engine.ts`: 쓰기 결과(배치 글리프의 폴백 face 키)로 `usesFallback` 을 정해 로그 항목마다 저장(undo·redo·재적용 동일). `changeKinds`·`runSave`(서브셋 교체) 모두 이 값을 쓴다 | core "M1" 1건(ToUnicode 에 U+0020 없는 원본, 공백 있는 라틴 편집 → `planSave` 에 `font-embed`, 저장 폴백 FontFile2 < 원본 1/10) |
| M2 | 갱신 실패(복구 아님) 뒤 커밋하면 직전 runs 가 커밋되어 마지막 화면 텍스트를 잃음. 커밋 RPC 중 입력은 모델에만 들어가 버려짐 | 커밋이 `idle()`·`isDirty()` 만 확인. 커밋 중 입력 차단 없음 | `edit-session.ts`: 커밋 전 `error !== null` 이거나 마지막 처리 프레임 seq ≠ 마지막 보낸 seq 면 현재 상태를 다시 보내고 성공해야 커밋. 실패하면 `{ kind: 'kept' }` 로 편집기를 열어 두고 오류 표시(`edit-controller.ts` 안내 문구). 커밋·취소 처리 중 텍스트·조합·형식 입력은 무시(차단 방식), `EditorLayer.tsx` 에 처리 중 안내 줄·`aria-busy` | viewer-ui `edit-session.test.ts` 3건(재전송 후 커밋 텍스트 = 마지막 입력 / 재전송 실패 시 커밋 RPC 없음·편집 계속 / 커밋 RPC 중 입력 무시) |
| M3 | 재적용 결정성이 세션 이력에 의존할 수 있음 | 같은 유니코드의 코드가 여럿일 때 우선순위(쪽에서 쓰인 코드)를 폰트를 처음 만든 쪽의 SourceMap 으로 한 번만 계산 | `font-assign.ts`: 우선순위·판정 캐시를 배정에 넘긴 SourceMap(판정 시점 쪽 상태, 초안·재적용 모두 제거 전 상태)별로 둔다. 같은 쪽 상태면 같은 코드 | core "M3" 1건(1쪽 먼저 편집한 세션과 0쪽만 편집한 세션의 0쪽 편집 블록 콘텐츠가 같음, 0쪽에서 쓰인 코드 200), pdf-ops "M3" 1건 |

- 남은 제한: 한 클러스터 안에서 기본 글자는 원본, 결합 문자는 폴백으로 나누어 쓰지 않는다. 편집 텍스트가 NFC 라 `é` 처럼 한 위치인 클러스터는 구간(`FontSegment`)으로 나눌 수 없다. 클러스터 전체를 폴백이 가지면 폴백으로 쓴다.
- shared-types 는 바꾸지 않았다.

### 8.1 마일스톤 리뷰의 머지 후 후속 항목(R- 번호, M4 계약 1.2 에서 처리)

| R- | 내용 |
| --- | --- |
| R-M4 | 엔진 `#failure` 상태가 되면 저장도 막혀 미저장 편집을 잃는다 |
| R-L1 | 뷰어 `ResilientPdf.beginParagraphEdit` 가 `renderScale` 을 넘기지 않는다 |
| R-L2 | 폴백 서브셋 뒤 `/BaseFont` 에 서브셋 태그가 없다 |
| R-L3 | OriginalFont·폴백 `mupdf.Font`·WriteContext 해제가 없다 |
| R-L4 | `edit-block.ts` `styleOf` 대체 경로가 바뀐 스트림을 옛 SourceMap 범위로 읽는다 |
| R-L5 | 폴백 폰트 로드 실패 시 판정 RPC 가 모두 실패해 편집 기능이 꺼진다 |

## 9. 사용자 확인 후 수정(2026-10-20)

### 9.0 Windows 사용자 확인 결과(2026-10-20)

- 환경(사용자 보고): Chrome 155.0.8059.82, Windows 11 Home 10.0.26200, Intel Core Ultra 5 228V, RAM 31.5 GiB, Microsoft 한글 IME. 빌드 main c3f84a9 dist.
- E1–E12: 아래 B1 외에는 문제 없음(사용자 보고, 항목별 관찰·진단 JSON·저장 파일 속성은 상세 미수신). 측정값은 없다.
- E12(d) Acrobat 표시: 미확인(미설치).
- 문제 1건(B1): 초과 상태에서 "영역 넓히기"를 누르면 한 문단이 여러 블록·단으로 갈라져 보임(사용자 보고). 파일·쪽·시점·오버레이 여부는 미수신. 9.1 에서 재현·수정.

### 9.1 사용자 보고 B1: "영역 넓히기" 뒤 한 문단이 여러 블록·단으로 갈라져 보임

상태: **재현·원인 확인·수정함.** 보고 조건(파일·쪽·시점·오버레이)은 알 수 없어 아래 조건을 모두 시도했다.

| 조건 | 결과 |
| --- | --- |
| 편집 중(초안) 화면 | 재현 안 됨. 편집 중에는 마우스 오버 테두리·레이아웃 오버레이·텍스트 층을 숨기고(`PageSurface.tsx`), "영역 넓히기" 는 `ReflowSummary.area` 만 바꾼다. 줄 나눔·글리프 위치·편집 블록 내용은 넓히기 전과 같다(줄 폭 불변) |
| Esc 커밋 뒤 마우스 오버 테두리(`getPageEditability`) | **재현.** 커밋한 편집 블록 하나가 판정 목록에서 레이아웃 문단 여러 개로 나온다 |
| 저장 → 재열기 뒤 | 같은 현상(편집 블록은 `/PdfEditorEdit` 로 다시 찾고, 레이아웃은 다시 복원) |
| 레이아웃 오버레이 켬 | 같은 원인으로 문단 상자가 여러 개(오버레이는 M2 레이아웃 그대로) |
| m0-sample(1단) 첫 문단에 글 추가 | 갈라짐 없음(4개 문단 모두 1개). 강제 줄바꿈 + 짧은 줄("Short line one.⏎Short line two.")이면 2개 |
| arxiv-2609.09268(2단) 1쪽 문단 6개 | 6개 중 4개가 2–9개로 갈라짐. 넘친 줄이 아래 문단과 겹친 경우 이웃 문단 줄과 섞임(최대 9개) |
| 코퍼스 24개 파일 첫 쪽, 60자 넘는 편집 가능 문단 최대 5개씩(원문 + 짧은 문장 추가, 넓히기 켬), 46건 | 16건 갈라짐. 이웃과 겹침 없이 갈라진 예: jnl-phwr-2025-18-36-1 #6(2줄 → 2개)·#8(3줄 → 3개), ustreas-mts-202509 #3. 양쪽 정렬 줄이 단어 간격에서 가로로 갈라진 예: jnl-jdis-2026-2-2-7 #6(9줄 → 9개, `[30,694,86,705]`·`[96,694,107,705]`·`[116,694,163,705]` 처럼 한 줄이 세 "단") |
| "영역 넓히기" 켬·끔 비교(같은 텍스트) | 갈라짐 수가 모든 건에서 같다. 넓히기는 원인이 아니라, 넘칠 만큼 글을 늘린 편집(줄 수 증가)에서 사용자가 함께 누르는 동작이다 |

원인

- 커밋 뒤 쪽 레이아웃은 M2 레이아웃 복원(`layout-recon` `splitParagraphs`)이 쪽 전체를 다시 나눈다. 편집 블록의 줄은 원 문서의 조판과 다르다(왼쪽 정렬 마지막 줄·강제 줄바꿈 뒤 짧은 줄, 원 문단이 한 줄이면 줄 간격 = 글자 크기 × 1.2, 양쪽 정렬 줄의 넓은 단어 간격). 그래서 `pitch`·`sentence-end`·`short-justified` 등의 규칙으로 블록이 여러 문단이 되거나, 넓힌 영역으로 이웃 문단과 붙으면 이웃 줄과 한 문단이 된다.
- `planPageEditability`(pdf-ops)는 레이아웃 문단마다 항목을 만들고 상자로 레이아웃 문단 bbox 를 썼다. 편집 대상은 블록 글자를 하나라도 포함하면 블록 전체(계약 D3)인데, 테두리는 갈라진 레이아웃 문단마다 따로 그려졌다(이웃 줄이 섞인 문단은 이웃 글자까지 덮음).

수정(`2534680`)

- `packages/pdf-ops/src/paragraph-edit.ts` `planPageEditability`: 편집 블록마다 항목 하나(첫 레이아웃 문단 id), 상자 = 블록 글자 상자(`analyzeBlock`). 같은 블록의 다른 레이아웃 문단은 목록에서 뺀다. 어느 항목으로 편집해도 대상은 블록 전체(기존 D3 규칙 그대로).
- 시험: core `edit-real.test.ts` "B1" 2건(강제 줄바꿈 블록이 레이아웃 문단 2개여도 판정 1개·상자가 두 줄을 덮음 / 이웃 문단과 한 레이아웃 문단으로 합쳐져도 판정 상자가 블록 글자만 덮음). 수정 전 코드에서 2건 모두 실패 확인. 통합 e2e `edit-integration.spec.ts` "B1"(실제 확장·core: m0-sample 문단을 두 줄로 고쳐 Esc 커밋 → 레이아웃 문단 2개, 두 줄 위 마우스 오버 테두리가 같은 항목이고 두 줄을 덮음).

남은 제한(수정 범위 밖)

| # | 내용 | 처리 |
| --- | --- | --- |
| 1 | 레이아웃 오버레이(M2 진단)·텍스트 층 읽기 순서·복사 순서는 레이아웃 복원 결과를 그대로 쓴다. 갈라진 블록의 줄이 다른 문단·단으로 잡히면 복사 순서가 어긋날 수 있다(jnl-jdis #6 의 가로로 갈라진 줄) | 처리함(9.6): layout-recon `fixedGroups` 힌트로 블록 하나 = 레이아웃 문단 하나 |
| 2 | 넓힌 영역의 줄이 이웃 문단과 한 레이아웃 문단이 되면 그 이웃 문단 글자는 따로 편집할 수 없다(더블클릭 대상이 블록). 겹침은 계약대로 `area-overlaps-content` 경고만 한다 | 사용자 확인 질문 9.4 #1 |

### 9.2 사양 변경(2026-10-20 사용자 결정)

| 변경 | 내용 | 파일 |
| --- | --- | --- |
| 1 글자 줄이기 제거 | `OverflowChoice`·`ParagraphFormat.overflow`·`ReflowSummary.fontScale`·reflow 축소 배율 탐색(0.8 ≤ s ≤ 1) 제거 | `packages/shared-types/src/edit.ts`, `packages/reflow/src/layout.ts`·`index.ts` |
| 2 자동 확장 | 넘치면 reflow 가 아래 변을 글 높이까지(`areaLimit` 까지) 내린다. 사용자 선택 없음. `format.area` 는 사용자 영역 그대로이고 실제로 쓴 영역은 `ReflowSummary.area`. 핸들로 글보다 작게 줄여도 다시 늘어난다. 상한에 막히면 `overflow = true` + `overflow-clipped`. reflow 규칙이라 커밋·undo·redo·재적용이 같은 결과(편집 단위 하나) | `packages/reflow/src/layout.ts` |
| 3 되돌리기 | 초과 패널은 상한에 막힌 초과에서만 보이고 버튼은 "되돌리기"(`#pe-edit-revert`) 하나. 도구 막대 "편집 취소" 와 같은 `cancelActive` 경로. 상한 초과가 남은 Esc·바깥 클릭 커밋은 허용(경고 상태) | `packages/viewer-ui/src/components/EditorLayer.tsx`, `style.css` |

이전 빌드 문서·로그 호환

- `/PdfEditorFormat` 읽기·쓰기는 `cleanParagraphFormat`(pdf-ops `edit-plan.ts`)으로 현재 필드(`area`·`align`·`firstLineIndent`·`lineHeight`·`firstBaselineOffset`)만 쓴다. 이전 `overflow`('expand'·'shrink'·'keep')·`fontScale` 은 버린다. `area`·`firstBaselineOffset` 이 숫자가 아니면 추출 텍스트 + 블록 상자로 시작한다(기존 5.3 대체 경로).
- 이전 `EditOp`(`format.overflow: 'shrink'` 등)를 `replayEdits` 하면 reflow 는 그 필드를 보지 않고, 다시 쓴 블록의 `/PdfEditorFormat` 에도 남지 않는다. 결과는 같은 op 에서 필드를 뺀 재적용과 같다.
- 이전 빌드에서 "글자 줄이기" 로 저장한 블록은 파일에는 축소된 글자로 남아 있고, 다시 편집하면 원래 글자 크기 + 자동 확장으로 다시 배치된다.

시험

| 패키지 | 시험 |
| --- | --- |
| reflow `layout.test.ts` | 초과 시 자동 확장·글자 크기 유지, 상한에서 멈춤 + 초과 유지 + `isOverflowClipped`, 넘치지 않으면 영역 불변, 글보다 작은 영역도 글 높이까지, 이전 `overflow`·`fontScale` 필드 무시(결과 동일), 결정성. `bench.test.ts` 축소 측정 → 자동 확장 측정 |
| pdf-ops `paragraph-edit.test.ts` | 이전 `/PdfEditorFormat`(format.overflow 'shrink', fontScale 0.85, 최상위 fontScale) 재열기 → 블록 형식으로 시작(추출 대체 아님), 이전 필드 없음, 다시 쓴 JSON 에도 없음, 영역이 깨진 형식은 추출 + 블록 상자 |
| core `edit-real.test.ts` | 자동 확장: 사용자 영역 불변·`reflow.area` = 글 아래·`getPageEdits` 영역, undo 한 번에 원문, redo·재적용 같은 텍스트·영역 / 이전 EditOp(shrink·0.85) 재적용 = 필드 뺀 재적용, 저장 JSON 에 이전 필드 없음. `edit-engine.test.ts` 상한 초과 경고 |
| viewer-ui `edit-session.test.ts` | 자동 확장(입력 형식에 overflow 없음, 사용자 영역 불변), 핸들로 줄여도 다시 늘어남, 상한 초과 + 경고 |
| e2e `edit-ui.spec.ts` "초과·영역" | 자동 확장·선택 UI 없음·지우면 원 영역, 핸들로 줄여도 다시 늘어남, 상한 초과 표시·경고·"되돌리기" 하나·넘친 줄 합성, 되돌리기 = 취소 경로(캔버스 복원, 커밋 RPC 없음), 상한 초과 Esc 커밋 |

### 9.3 검증(2026-10-20, 이 worktree `m3-ux`)

| 명령 | 결과 |
| --- | --- |
| `pnpm exec turbo run build typecheck test test:e2e --force` | 통과(25개 작업, 캐시 0, 종료 코드 0) |
| 단위 | shared-types 2, layout-recon 49(3 skip), reflow 55, pdf-ops 388(3 skip), core 219(4 skip), viewer-ui 232, extension 43 |
| e2e | 87 통과, 2 skip(옵트인 반응 시간 측정·기존 M1 동적 skip) |
| `pnpm lint`·`pnpm exec prettier --check .` | 통과 |

### 9.4 사용자 확인 질문

| # | 질문 | 사용자 답변(2026-10-20) |
| --- | --- | --- |
| 1 | 보고한 현상이 커밋(Esc·바깥 클릭) 뒤 마우스를 올렸을 때 테두리가 여러 개로 보인 것인지, 레이아웃 오버레이를 켠 상태였는지(9.1 표). 이번 수정은 마우스 오버 테두리·편집 대상만 고쳤고 레이아웃 오버레이·복사 순서는 그대로다 | 레이아웃 오버레이를 켰을 때 본 것 → 9.6 에서 레이아웃 결과 자체를 블록 한 문단으로 고침 |
| 2 | 넓힌 영역이 아래 문단과 겹쳐 그 문단과 합쳐진 경우, 아래 문단을 따로 편집하려면 편집 블록의 영역을 줄여야 한다. 이 동작으로 충분한지, 겹침 자체를 막을지(현재 결정: 경고만) | 경고만(현행 유지) |
| 3 | 자동 확장이 일어났다는 표시(예: "영역 넓힘" 칩)가 필요한지. 현재는 영역 테두리만 넓어진다 | 표시 필요 없음(현행 유지) |

### 9.5 메인 세션 반영(2026-10-20 반영함)

- `docs/m3-contract.md` 5.4 표(축소·넓히기·그대로 → 자동 확장·상한 초과), 5.9 "초과 UI" 행, 4절 `edit.ts` 목록의 `OverflowChoice`, D3 `/PdfEditorFormat` 필드 설명(이전 필드 무시). PLAN.md 1.3 초과 처리 문구.
- `docs/m3-reflow.md` 2.6·요약 표의 `fontScale`·벤치 표, `docs/m3-core.md`·`docs/m3-pdf-ops.md` 의 overflow·fontScale 언급.
- 5.1 판정 목록이 편집 블록을 한 항목으로 합친다는 규칙(9.1)을 계약 D3 또는 5.1 에 추가.
- 반영: PLAN.md v2.12 1.3·상태·변경 이력, 계약 수정 5(1.1·4절·5.1·5.4·5.9·변경 이력), `docs/m3-reflow.md`·`docs/m3-core.md`·`docs/m3-pdf-ops.md` 머리말에 대체 안내.

### 9.6 레이아웃 오버레이(사용자 답변 2026-10-20)

사용자 답변: B1 에서 본 갈라짐은 레이아웃 오버레이(도구 막대 "레이아웃")를 켠 상태였다. 9.1 수정은 마우스 오버 테두리(`getPageEditability`)만 고쳤으므로 오버레이·읽기 순서·복사 순서는 그대로 갈라져 있었다.

원인

- 오버레이는 `getPageLayout`(core) → `reconstructPage`(layout-recon) 결과를 그대로 그린다(`LayoutLayer.tsx`). 레이아웃 복원은 편집 블록을 모르므로 블록 줄을 M2 규칙(`pitch`·`sentence-end`·`short-justified`, 양쪽 정렬 줄의 단어 간격에서 가로 분리)으로 다시 나누거나 이웃 문단 줄과 합친다(9.1 원인과 같다).

수정

| 파일 | 내용 |
| --- | --- |
| `packages/layout-recon/src/reconstruct.ts` | `ReconOptions.fixedGroups?: number[][]`(PageModel 줄 번호 묶음). 묶음마다 흐름 문단 정확히 하나: 묶음 줄은 표·도형 라벨·머리·꼬리·영역 쌓기·문단 나누기에서 빼고, 같은 행 조각은 간격과 무관하게 이어(`buildUnits` joinRow) 줄은 위→아래. 문단은 묶음 상자 합으로 XY-cut 에 들어가 첫 줄 자리의 읽기 순서·열을 받고, 묶음 상자는 영역 쌓기 장애물이라 블록 위·아래 이웃 줄이 블록을 건너 이어지지 않는다. 역할은 다른 흐름 문단과 같은 규칙(`flowRole`), bbox·chars·styleRuns·lineHeight·align 은 `buildParagraph`. 보이지 않는 줄·가로가 아닌 줄·범위 밖 번호는 무시하고, 여러 묶음에 든 줄은 앞 묶음이 갖는다. 힌트가 없거나 빈 배열이면 M2 결과와 같다(순수 함수 유지) |
| `packages/pdf-ops/src/paragraph-edit.ts` | `editBlockLineGroups(model, map, linkage, blocks)`: 글자의 원본 연산(`linkage.charOp` → `SourceOp.formPath`)에 블록 Form 객체 번호가 있으면 그 블록 글자(analyzeBlock 과 같은 규칙). 줄 단위 배정: 보이는 글자의 과반(절반 초과)이 속한 블록, 과반이 없으면 묶음에 넣지 않는다(보통 복원) |
| `packages/pdf-ops/src/edit-block.ts` | `listEditBlocks` 가 먼저 리소스 사전(쪽·Form /XObject, 재귀)에서 /PdfEditorEdit Form 을 찾고, 없으면 콘텐츠를 파싱하지 않는다. 코퍼스 72쪽 합계 147 ms → 3.7 ms(쪽당 최대 40 ms → 0.4 ms) |
| `packages/core/src/session.ts`·`edit-engine.ts` | `getPageLayout` 이 `fixedGroups` 를 넘긴다. 블록 목록은 편집 엔진 캐시(`EditEngine.editBlocks`, 초안 시작·커밋·undo·redo 때 갱신), 블록이 없는 쪽은 원본 연결을 만들지 않는다. 힌트는 레이아웃 캐시와 같이 비워져(`invalidateAround`) 다시 계산된다. 저장 → 재열기 뒤에도 /PdfEditorEdit 로 찾는다 |

`planPageEditability` 의 블록당 한 항목 규칙(9.1)은 그대로 둔다. 레이아웃 문단이 블록당 하나가 되어 항목 id 는 그 문단 id 와 같다.

시험

| 패키지 | 시험 |
| --- | --- |
| layout-recon `reconstruct.test.ts` "fixedGroups" 7건 | 강제 줄바꿈·짧은 줄·같은 행 두 조각이 문단 하나(줄 위→아래, 줄 순서 무관), 이웃 문단과 합쳐지던 줄이 떨어짐, 겹친 이웃, 두 단에서 열·읽기 순서, 잘못된 번호·빈 묶음·겹친 묶음, 빈 힌트 = M2 결과. 모두 `validateLayout` 통과 |
| pdf-ops `edit-block-lines.test.ts` 2건 | 블록 순서·Form 안 블록·블록 밖 줄 제외, 과반 규칙(공백 제외·반반은 제외·연결 실패 글자는 블록 밖) |
| core `edit-real.test.ts` | B1 2건 갱신(레이아웃 문단 하나·이웃 문단 따로), "9.6 레이아웃" 1건(두 단 쪽, 강제 줄바꿈 + 긴 글 → 레이아웃 문단 하나·같은 열·이웃 문단 그대로, undo 원 문단·redo 다시 하나, 저장 → 재열기 뒤 하나). 힌트를 끈 코드에서 3건 모두 실패 확인 |
| e2e `edit-integration.spec.ts` "B1·9.6" | 실제 확장: 두 줄로 고쳐 Esc 커밋 → `getPageLayout` 에 블록 문단 하나("Short line one. Short line two."), 문단 수 = 편집 전, 두 줄 마우스 오버 테두리 같은 항목, 레이아웃 오버레이 켬 → `#pe-layout-canvas` `data-paragraphs` = 편집 전 문단 수 |

코퍼스 점검(24개 파일 첫 쪽, 60자 넘는 본문 문단 최대 5개씩, 원문 + " Added short sentence.⏎Hard break line." 커밋, 41건)

| | 블록이 레이아웃 문단 여럿 | 이웃 줄과 한 문단 | `validateLayout` 위반 |
| --- | --- | --- | --- |
| 힌트 없음(수정 전) | 33 | 16 | 0 |
| 힌트 있음 | 0 | 0 | 0 |

M2 정확도 하네스(`layout-accuracy.test.ts`, dev 30쪽)는 `reconstructPage` 를 힌트 없이 부르므로 영향이 없다: 문단 F1 0.8998, P 0.877, R 0.923(docs/m2-accuracy.md 기록과 같음).

남은 제한

| # | 내용 |
| --- | --- |
| 1 | 줄 배정은 줄 단위다. MuPDF 가 블록 글자와 다른 글자를 한 줄로 묶고 과반이 블록이면 그 다른 글자도 블록 문단에, 과반이 아니면 블록 글자가 보통 복원으로 간다(코퍼스 점검에서는 없음) |
| 2 | 블록 문단 역할은 흐름 문단 규칙이다. 원 문단이 머리·꼬리·표 셀·도형 라벨이었어도 편집 뒤에는 흐름 문단(heading·body 등)이다 |
| 3 | 넓힌 영역이 이웃 문단과 겹치면 두 문단 상자가 겹쳐 그려진다(문단은 따로). 겹침 자체는 9.4 #2 결정대로 경고만 |


## 10. M4 작업 S4: 같은 텍스트 bbox 초과 26/110 진단·R-L3(2026-10-21)

브랜치 `m4-m3fu`(기준 m4 `b3fdde8`). 계약 `docs/m4-contract.md` 1.2·5.2 작업 S4.

### 10.1 진단 방법

- 대상: 4절 측정(`edit-corpus-after-justify.json`)의 같은 텍스트 편집 110건 중 `overflowInitial` 26건(자동 확장 이후 기준으로는 아래 변이 원 bbox 아래로 내려간 편집).
- 문단마다 `planParagraphEdit` → `updateParagraphDraft`(계획 runs·format 그대로)를 돌려 원 줄(PageModel 글자 원점)과 reflow 줄(`PlacedLine`)을 비교했다. 원 줄 텍스트의 reflow 자연 폭(줄 끝 공백 제외) − 줄 폭 = 폭 초과량. 글자마다 원 전진(다음 글자 원점 차)과 reflow 전진을 비교해 차이가 고른지(자간), 글자쌍에 몰리는지(커닝)를 나눴다. 원인 후보는 원본 콘텐츠 스트림의 `Tc`·`TJ` 숫자·합자 코드로 확인했다.
- 진단 스크립트는 저장소에 넣지 않았다(임시 vitest 파일).

### 10.2 분류(26건)

| # | 원인 | 건수 | 문서·쪽·문단 | 근거 | 담당 |
| --- | --- | --- | --- | --- | --- |
| C1 | 원본 자간 `Tc`(음수) 미반영. 시작 상태에 자간이 없어 reflow 가 명세 폭으로 놓고 줄이 넓어져 한 줄 더 생김 | 8 | ustreas-mts-202509 4쪽 #0·#80, jnl-phwr-2025-18-36-1 1쪽 #1, nist-sp800-53r5 1쪽 #2, jnl-jdis-2026-2-2-7 1쪽 #1·#4, 4쪽 #0·#1 | 글자마다 전진 차가 고름(ustreas +0.022 pt, phwr +0.067 pt, 표준편차 ≤ 0.002). 스트림 `-0.022 Tc`, `-0.01 Tc`(크기 6.67), `-0.019 Tc`, `-.0498`·`-.092`·`-.128 Tc`. 폭 초과 0.87–48.4 pt | 시작 상태·계약(10.4 제안 1) |
| C2 | 원본 `TJ` 글자쌍 커닝 미반영 | 9 | fed-h41-current 1쪽 #3, 4쪽 #1, nasa-eo-2023-sepoct 1쪽 #2·#7, nasa-eo-2024-janfeb 1쪽 #2·#7, nasa-eo-2019-maraprl 4쪽 #6(자간 `Tc` 함께), zen-beamer-7535020 1쪽 #1·#2 | 전진 차가 글자쌍에 몰림(`Y` +0.64, `A` +1.04, `T` +1.52 pt 등). 스트림 `[(Over Thirty Y)55 (ears ... NASA)92 (\222)37 ...]TJ`, `[(Factors )46(A)...]TJ`, `[(2. )27(Maturity ...]TJ`. 폭 초과 0.31–28.7 pt | 시작 상태(10.4 제안 2) |
| C3 | 합자 `fi` 한 글리프를 `f`·`i` 두 글리프로 배치 | 1 | nist-ai-100-1 1쪽 #1 | 스트림 `(Arti\002cial)`(코드 2 = fi 합자). reflow `f` +8.25·`i` −6.89 pt, 합계 +1.37 pt | 시작 상태·font-assign(10.4 제안 3) |
| C4 | TeX 덧쓰기 악센트(`´` 를 따로 전진하는 글리프로 배치, 4절 확인분) | 3 | zen-beamer-10545284 1쪽 #1·#2, 4쪽 #0 | 시작 텍스트 `pr´actica`·`Jos´e`·`f´ısico`. `´` 의 reflow 전진 +3.65–7.65 pt(원본은 다음 글자와 겹침). 폭 초과 5.9–11.5 pt | 시작 상태(10.4 제안 4) |
| C5 | 원본 폰트에 공백 글리프가 없어 폴백으로 간 공백(합성 공백)이 폴백 높이(1160·−288)로 줄 상자를 키움 | 3 | arxiv-2609.10511 1쪽 #1, zen-ko-sim-21496576 1쪽 #1·#2 | 줄 나눔은 원본과 같고 contentBox 위 −5.5 pt·아래 +1.0–1.3 pt. 폴백 글리프가 모두 공백 | **reflow, 수정함(10.3)** |
| C6 | 시작 상태 `format.area` 위 변이 `areaLimit`(삽입점 직사각형 클립) 밖. reflow 가 상한으로 자른 위 변에서 기준선을 재 줄 전체가 0.58 pt 내려감 | 1 | fed-h41-current 1쪽 #2 | area 위 108.36, areaLimit 위 108.94, `firstBaselineOffset` 10.86 → 기준선 119.80(원본 119.22). 타입 주석은 "area 는 areaLimit 안" | 시작 상태(10.4 제안 5) |
| C7 | 기호 폰트(CMSY7) FontDescriptor `Descent` 가 커서 줄 아래가 내려감 + 위첨자 상승이 시작 상태에 없어 기준선 위로 놓임 | 1 | arxiv-2609.09268 1쪽 #2 | 줄 내림 −6.63 pt(크기 7 × −0.95 em), contentBox 아래 +3.6 pt. 원 줄의 위첨자 `1, 2`·`3`·`∗`·`†` 기준선 96.3, 본문 99.9 | 시작 상태(남은 제한) |

- 합계 26. reflow 원인은 C5 하나다. 나머지 23건은 원본 배치 정보(자간·커닝·합자·악센트 겹침·위첨자 상승·클립 영역)가 시작 상태(`TextRun`·`ParagraphFormat`)에 담기지 않아 생긴다.
- 원 bbox 폭 = 원 줄 폭이라 폭 초과가 0.31 pt 여도 마지막 단어가 다음 줄로 간다(줄 폭 판정 여유 `FIT_EPSILON` 0.01 pt).

### 10.3 reflow 수정

| 파일 | 수정 |
| --- | --- |
| `packages/reflow/src/layout.ts` | `lineMetrics`: 글자가 있는 줄의 올림·내림은 공백 클러스터(`SP`)를 빼고 정한다. 공백만 있는 줄은 공백 폰트 값을 쓴다. 글리프 없는 줄은 기존 캐럿 규칙 |
| `packages/reflow/test/layout.test.ts` "줄 높이" 2건 | 높은 폰트(1160·−288)의 공백이 낀 줄의 올림·내림·contentBox·영역이 공백 없는 줄과 같음(수정 전 실패 확인), 공백만 있는 줄은 공백 폰트 값 |

- 재측정(4절 하네스, `EDIT_CORPUS_KINDS=same EDIT_CORPUS_ENGINES=mupdf`, 110건, 72 s): 아래 변이 원 bbox 아래로 내려간 편집 26 → **23**(C5 3건 해소, 나머지 23건은 10.2 의 C1·C2·C3·C4·C6·C7 과 같은 목록). 상한 초과 0, 오류 0. 영역 밖 렌더 변화 0 110/110, 새 글자 잉크 109/110, 텍스트(엄격) 102/110 으로 4절 같은 텍스트 행과 같다.

### 10.4 시작 상태·계약 쪽 제안(S1·메인 세션 판단)

| # | 대상 | 제안 | 해소 예상 |
| --- | --- | --- | --- |
| 1 | `RunStyle`·`FontSegment`(shared-types·reflow 타입, 계약 변경) + `edit-plan.ts` | 구간에 자간(pt, 원본 `Tc` × 글자 크기 × `Tz`)을 싣고 reflow 가 클러스터 전진에 더한다. 쓰기는 이미 위치 차이를 TJ 숫자로 쓰므로 바뀌지 않는다 | C1 8건 |
| 2 | `edit-plan.ts` | 같은 텍스트 재현용으로 영역 가로를 원 줄 자연 폭(reflow 셰이퍼 기준)의 최댓값까지 넓힌다(`areaLimit` 안). 커닝을 계약에 넣지 않는 최소 보정. 대안: 원본 TJ 커닝을 글자쌍 조정으로 시작 상태에 싣는다(계약 변경) | C2 9건(폭 초과 0.31–28.7 pt), 제안 1이 없으면 C1 도 |
| 3 | `edit-plan.ts`·`font-assign.ts` | 원본 합자 글리프(ToUnicode 1코드 → 여러 코드 포인트)를 역매핑에 넣어 `fi` 클러스터열을 원 코드 하나로 쓴다 | C3 1건 |
| 4 | `edit-plan.ts` | 따로 놓인 덧쓰기 악센트(U+00B4·U+0060·U+00A8·U+02C6·U+02DC 등 간격 문자, 글리프 상자가 다음 글자와 가로로 겹침)를 다음 글자와 합쳐 NFC 로 시작 텍스트를 만든다(`´a` → `á`, `´ı` → `í`). 원본 폰트에 합성 글자가 없으면 폴백(font-assign H1 규칙) | C4 3건 |
| 5 | `edit-plan.ts` | `format.area = bbox ∩ areaLimit`, `firstBaselineOffset` 는 자른 위 변 기준 | C6 1건 |

- C7(위첨자·아래첨자 상승, 기호 폰트 높이)은 M3·M4 계약 범위 밖이다. 남은 제한으로 둔다.

### 10.5 R-L3 해제

| 파일 | 수정 |
| --- | --- |
| `packages/pdf-ops/src/font-assign.ts` | `FontState.dispose()`: 원본 폰트마다 `OriginalFont.destroy()`(탐침 임시 문서와 그 안 폰트 객체), 폴백 `mupdf.Font.destroy()`. 여러 번 불러도 된다. 해제 뒤 `original()`·폴백 조회는 예외. 문서·편집 블록 객체는 건드리지 않는다. `OriginalFont.destroy()` 는 탐침 폰트 객체도 해제하고, 해제 뒤 새 글자는 탐침을 다시 만든다 |
| `packages/pdf-ops/test/font-assign.test.ts` 3건 | 해제 대상 수(PDFDocument·Font `destroy` 각 1회), 두 번째 호출 무동작, 해제 뒤 예외, 만들지 않은 자원은 해제하지 않음, `OriginalFont.destroy` 반복·재탐침 |

- 연결 남음: `FontState` 는 `paragraph-edit.ts` 의 `FontManager` 가 WeakMap 으로 가진다. `FontManager.dispose()`(→ `fontStateOf(this).dispose()`)는 S1 파일이고, 문서 닫기·엔진 재생성 때 부르는 곳은 core(S2) 다. WriteContext(`edit-apply.ts`) 해제도 S1 범위다.
