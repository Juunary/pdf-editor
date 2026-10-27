# M4 pdf-ops(S1): 표 셀 편집 · 벡터 패스 판정·쓰기 · 레이아웃 셀 복원

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-21 |
| 브랜치 | `m4-pdf-ops`(기준 `m4` `b3fdde8`, worktree `/mnt/nas4/kjune/pdf-editor-m4-pdf-ops`) |
| 범위 | `docs/m4-contract.md` 5.2 작업 S1: 4.1 셀 편집, layout-recon `reconstruct.ts` 셀 묶음 규칙, 3절 인터프리터 선택 필드, 4.2 패스 판정, 4.3·D3·D4 패스 쓰기, R-L4, V1–V4, 판정 시간, 편집 가능 비율 |
| 상태 | 범위 구현 완료. V1–V4 측정 완료(합성 + 코퍼스). 판정 시간 예산 충족. 계약 불일치 7건(6절). 메인 세션 결정이 필요한 것은 4(S2 연결)·5(shared-types)·7(위치 보존) |
| 측정 환경 | 서버 `sailab01`, Node 22.18.0, npm `mupdf` 1.28.1, `pdfjs-dist` 6.4.299(legacy), Poppler 22.02.0. 렌더 비교는 scale 2, 주석 제외, 채널 차 8 초과 픽셀 수, 허용 영역 여백 2pt(M3 계약 8.3 과 같음) |
| 코퍼스 | `/mnt/nas4/kjune/pdf-editor/fixtures/corpus`(git 밖) 24문서 1,992쪽 |

## 1. 구현

| 계약 | 파일 | 내용 |
|---|---|---|
| 3절 | `src/content-interp.ts` | `SourceOp.pathOps`(칠하기·`W`·`W*` 의 구성 연산 id, 경로 버퍼가 들고 다님), `SourceOpState.strokeColorOps`(CS+SC/SCN 또는 G/RG/K), `lineWidthOps`(`w`, gs `/LW` 는 extGStateOps 로 봄), `SourceOp.operandRanges`(숫자·이름 피연산자, 구성·색·`w` 연산만 기록) |
| 4.2 | `src/path-edit.ts` `planPathEditability`·`planPathEdit` | 칠하기 연산 단위 판정, 제한 사유·대상 아님·경고, 지문 `PathFingerprint`(칠하기 이름·구성 연산 수·쪽 공간 상자 1e-3·구성 연산 바이트 cyrb53 해시). 쪽 분석은 SourceMap 별로 한 번(WeakMap) |
| 4.3·D3·D4 | `src/path-edit.ts` `preparePathEdit`·`writePathEdit`·`pathEditWarnings` | 지문 확인, Form 사용 경로 복제(같은 경로 접두는 복제본 하나), 공유 /Contents 사본, 스트림마다 원본 바이트 기준 교체 목록(반복 쓰기), 이동·크기·점 편집·색·선 두께·삭제·다중 선택 |
| 4.1·D1·D5 | `src/cell-edit.ts`(새 파일), `src/edit-plan.ts`, `src/paragraph-edit.ts`, `src/text-map.ts`(새 파일, `offsetMap` 분리) | 셀 대상(셀 문단 전부), 셀 상자·여백·상한·정렬·시작 영역, 줄 잇기, `target.cell`, 판정 목록 셀 한 항목, `planPageEditability.paths` |
| 4.1 BLOCKER | `packages/layout-recon/src/reconstruct.ts` | `fixedGroups` 줄도 표 감지 입력. 한 셀에 든 묶음 = 그 셀 문단 하나(`table` 설정). 한 셀에 들지 않는 묶음은 빼고 다시 감지(흐름 문단, M3 9.6 그대로) |
| R-L4 | `src/edit-apply.ts`, `src/edit-block.ts`, `src/paragraph-edit.ts` | 초안 시작 때 대상 글자 전부의 모양을 해석해 두고(연산마다 한 번), 쓰기·폰트 배정은 바뀐 스트림을 판정 시점 범위로 다시 읽지 않는다(`styleFor`: 없으면 가장 가까운 글자 번호의 해석) |

### 1.1 패스 판정 세부

| 사유 | 판정 |
|---|---|
| `clip-path` | 첫 구성 ~ 칠하기 사이 `W`·`W*`, 또는 연결된 PathInfo 에 clip(패턴이 아닐 때) |
| `pattern-or-shading` | 칠하는 쪽 색 연산이 패턴(`scn /이름`, 색공간 Pattern), 또는 fill·stroke PathInfo 수가 칠하기 종류와 다름(셰이딩 패턴은 clip + fillShade) |
| `path-op-unparsed` | `pathOps` 없음, 피연산자 수·숫자 문법 불일치, 토큰 사이 공백 아닌 바이트 |
| `path-spans-streams` | 구성 연산과 칠하기 연산의 스트림이 다름 |
| `inside-text-object` | 같은 콘텐츠 실행(formPath 배열) 안 BT ~ ET 사이 |
| `path-interleaved-ops` | 첫 구성 ~ 칠하기 사이 구성·`W` 밖 연산(`Do` 포함). detail 에 첫 연산 이름 |
| `soft-mask` | 칠하기 시점 효력 있는 gs 의 /SMask(뒤의 gs 가 이김, /None 은 끔) |
| 연산 limits | 칠하기·구성 연산의 `unmatched`·`tokenizer-error`·`spans-stream-boundary`·`outside-page-content`·`form-depth-exceeded`. `optional-content` 는 경고, `tagged-content`·`form-inherits-resources` 는 제한 아님 |
| `singular-ctm` | 칠하기 시점 CTM 행렬식 0(1e-12) 또는 유한하지 않음 |

- 대상: 연산 `S s f F f* B B* b b*` 이고 paintSeq 가 있고 PathInfo 가 연결된 것. `n`·Form BBox 클립·`sh`·이미지·텍스트(Type3 포함)·클립 전용 PathInfo 는 목록에 없다. 패턴으로 칠한 칠하기는 PathInfo 가 clip 이지만 칠하기 연산 기준으로 목록에 넣고 `pattern-or-shading` 으로 표시한다(대표 PathInfo = 그 clip).
- PathInfo 가 연결되지 않은 칠하기(꺼진 /OC 등 paintSeq 없음, 연결 실패)는 목록에 없다(상자를 알 수 없음).
- 계획 경고: `optional-content`, `shared-form`(그 Form 이 이 쪽에서 둘 이상의 사용 경로로 쓰이거나 둘 이상의 쪽 Resources /XObject 에 직접 있음), `tagged-structure-unlinked`(복제할 Form 에 /StructParents).
- 편집 경고(`pathEditWarnings`): `color-space-changed`, `path-clipped`(새 상자가 칠하기 시점 직사각형 클립 상자 밖, 0.5pt 여유, 비직사각형 클립은 판정 안 함), `table-rule-removed`(삭제한 패스 상자가 괘선 전략 표 상자와 1pt 안에서 겹침).

### 1.2 패스 쓰기 세부

- 페이지 공간 아핀 `transform` 은 b = c = 0(이동·확대축소)만 받고, 콘텐츠 공간 변환 A = M·T·M⁻¹(M = CTM × userToPage)로 모든 점을 옮긴다.
- 점 대응표(`constructPoints`): `m`·`l` 1점, `c` 3점, `v` 3점(첫 점은 현재점), `y` 3점(셋째 = 둘째 피연산자), `re` 4점(MuPDF fz_rectto 순서) + Z, `h` 0점. 모델에 `segments` 가 있으면 점 수·좌표·세그먼트 수가 같을 때만 점 편집을 받는다.
- 다시 쓰기: 바뀐 점이 있는 구성 연산만 다시 쓴다(`fmt9`). `re` 는 결과가 축 정렬 직사각형이면 `x y w h re`, 아니면 `m l l l h`. `v` 는 첫 제어점이 새 현재점과 같으면 `v`, 아니면 `c`. `y` 는 둘째·셋째 점이 같으면 `y`, 아니면 `c`.
- 속성: 첫 구성 연산 앞 `q <색> <w> `, 칠하기 뒤 ` Q`. 색은 D3(원래 성분 수 1·3·4 의 Device 공간, Gray 에 채도 > 0·Separation·DeviceN·Indexed·Lab 은 DeviceRGB + `color-space-changed`, 8비트로 원래 rgb 와 같으면 쓰지 않음, CMYK 는 단순 변환). 선 두께는 페이지 pt ÷ √|det M|, 선 없는 칠하기(`f` 류)에는 쓰지 않는다. 바뀐 속성이 없으면 q/Q 를 넣지 않는다.
- 삭제: 첫 구성 연산 시작 ~ 칠하기 끝을 공백 하나로 바꾼다(사이 공백·주석 포함). 처음에는 `n` 이었으나 리뷰 L1 에서 바꿨다(짝 없는 `n` 은 엄격한 프리플라이트가 문제 삼는다). 뒤 칠하기의 paintSeq 는 하나씩 당겨지고 대상 확인은 지문이 맡는다.
- 반환 상자: 새 점의 쪽 공간 상자 + 원래 선 폭 여백(원 PathInfo 상자 − 원 점 상자, 변마다, 선 두께 비율 반영). 삭제는 원 상자.

### 1.3 셀 편집 세부

- 대상: `LayoutParagraph.table` 이 있고 레이아웃에서 셀을 찾은 문단. 셀 문단 전부를 이은 문단(id = 셀 첫 문단, `chars`·`lines`·`styleRuns` 를 이음)으로 M3 분석을 그대로 한다. 셀을 찾지 못한 표 문단은 흐름 문단처럼 판정한다. 도형 라벨은 `not-flow-paragraph` 그대로.
- 줄 잇기: 셀 안 줄 사이(문단 안·문단 사이 모두)는 자동 줄바꿈이면 공백, 아니면 `\n`. 자동 줄바꿈 = 앞 줄 폭 + 0.25em + 다음 줄 첫 단어 폭 > 셀 안쪽 폭 − 0.5pt. 문단 사이는 기준선 간격이 앞 문단 줄 간격(없으면 다음 문단)과 ±10% 안일 때만 공백(계약 불일치 2).
- 셀 상자: 괘선 표는 레이아웃 셀 상자. 정렬 전략 표는 바깥 열·행을 이웃 글자 간격 최솟값의 절반(없으면 1em)만큼, 표 상자가 더 크면 표 상자까지 넓힌다.
- 여백 = 변마다 min(원 글자와 경계 간격, 2pt). 상한 = (셀 상자 − 여백) ∪ 원 글자 상자, 그다음 M3 상한(쪽·클립·Form)과 교집합. 편집 블록 재편집은 블록 BBox(만들 때의 상한)를 그대로 쓴다.
- 정렬: 괘선 표는 셀 안 좌·우 간격 비교(차 < 1pt 가운데). 정렬 전략 표는 같은 열(병합 없는 셀) 글자 상자의 x0·x1·가운데 퍼짐 최소 키(셀 2개 이상), 아니면 간격 비교.
- 시작 형식: 영역 가로 = 셀 안쪽(정렬한 변은 원 글자 위치, 계약 불일치 1), 세로 = 글자 상자. 줄 간격 = 첫 문단 값, 없으면 셀 줄 기준선 간격 중앙값. 들여쓰기 0.
- 판정 목록: 셀마다 한 항목(셀 첫 문단 id, 상자 = 셀 상자, `cell` 설정). 편집 블록이 든 셀도 한 항목.

## 2. 검증 전제

### 2.1 V1 구성 연산 범위·끼인 연산

| 측정 | 결과(코퍼스 1,992쪽, 2026-10-21 실측) |
|---|---|
| 대상 칠하기 수(목록 항목) | 397,072 |
| 구성 ~ 칠하기 사이에 다른 연산이 낀 칠하기 | **0** |
| 구성 연산이 다른 /Contents 스트림에 있는 칠하기(`path-spans-streams`) | 27 |

- 합성: `10 10 m 2 w 100 10 l S` → `path-interleaved-ops`, /Contents 두 스트림에 나뉜 경로 → `path-spans-streams`(시험 `path-edit.test.ts`).
- 결론: 전제 V1 은 코퍼스에서 성립. 끼인 연산 사유는 비표준 파일 방어용이다.

### 2.2 V2 q/Q 감싸기·V3 피연산자 다시 쓰기(세 엔진)

| 표본 | 쪽 | 감싼·다시 쓴 칠하기 | V2 MuPDF/pdf.js/Poppler | V3 MuPDF/pdf.js/Poppler |
|---|---|---|---|---|
| arxiv-2609.09268 | 10 | 279 | 0 / 3 / 0 | 0 / 0 / 0 |
| arxiv-2609.09268 | 14 | 145 | 0 / 4 / 0 | 0 / 0 / 0 |
| arxiv-2609.10511 | 7 | 3,190 | 0 / 0 / 0 | 0 / 0 / 0 |
| arxiv-2609.10511 | 3 | 995 | 0 / 0 / 0 | 0 / 0 / 0 |
| kogl-mods-cpi-202609 | 4 | 32,041 | 0 / 2,484 / 0 | 0 / 0 / 0 |
| kogl-mods-cpi-202609 | 6 | 7,003 | 0 / 0 / 0 | 0 / 0 / 0 |

- V2 쪽 전체(편집 가능 칠하기 전부를 동시에 감쌈): MuPDF·Poppler 0 px. pdf.js 는 세 쪽에서 차이(3·4·2,484 px). arxiv-2609.09268 10쪽의 차이 픽셀 3개는 감싼 패스들(배경 채움·막대 채움·세로선)이 맞닿은 경계의 안티에일리어싱이고 그 패스 상자 1pt 안이다. 주변 패스 7개를 하나씩만 감싸면 pdf.js 도 0 px(2026-10-21 실측). kogl-mods-cpi-202609 4쪽(칠하기 32,041개를 모두 감쌈)의 차이 위치는 분석하지 않았다. 단일 패스 편집 표본 76건(5.1)은 세 엔진 허용 영역 밖 0 px.
- 판단: 단일 패스 편집에서 V2 성립. 맞닿은 패스 여러 개를 함께 고치는 다중 선택은 pdf.js 에서 그 패스들 상자 안 경계 픽셀이 달라질 수 있다(변경 허용 영역 안이라 DoD 위반 아님).
- V3: 6쪽 모두 세 엔진 0 px. 합성(12자리 좌표를 9자리로)도 세 엔진 0 px(`path-edit.test.ts` "V2·V3 합성").

### 2.3 V4 셀 편집 블록 복원

| 시험 | 결과 |
|---|---|
| layout-recon `reconstruct.test.ts` "fixedGroups 셀 편집 블록" 4건 | 괘선 3×3 표(두 줄 블록)·정렬 전략 3행 표(숫자 셀) 블록 뒤 표 모양 유지, 그 셀 문단 = 블록 하나(`table` 설정). 수정 전 코드에서 3건 실패 확인 |
| pdf-ops `cell-edit.test.ts` V4 2건 | 실제 리플로우 커밋 → 재추출 → `fixedGroups` 레이아웃: 괘선 표·정렬 전략 표 모양 유지, 셀 문단 하나, 다시 편집하면 같은 셀(`rewrite-block`, `target.cell`) |
| 코퍼스 셀 표본(5절) | 표 쪽 8쪽 셀 20개 × 편집 3종 = 60건 중 커밋 뒤 표 모양(전략·행·열) 유지 60건, 그 셀 문단 = 블록 하나 54건. 어긋난 6건은 fed-combined-finstmt-2025 7쪽 `$ 203`(3건, 7절 1)과 kogl-nabo-finstmt2025 85쪽 여러 열에 걸친 줄을 담은 셀(3건, 7절 2) |
| M2 정확도 하네스 | `LAYOUT_ACC_SPLIT=all`(67쪽) 결과 JSON 이 수정 전 코드와 쪽별로 같음(dev 문단 F1 0.8998, all 0.8731). 하네스는 힌트를 쓰지 않는다 |

## 3. 판정 시간

| 측정 | 결과(2026-10-21 실측, 코퍼스 1,992쪽) |
|---|---|
| `planPathEditability` 쪽당 | 중앙값 0.21 ms, p95 2.89 ms, 최대 155 ms(kogl-mods-cpi-202609 9쪽, 칠하기 143개·연산 577,994개 중 구성 연산 약 57만 개) |
| 코퍼스 최대 패스 쪽 | kogl-mods-cpi-202609 4쪽, 판정 항목 32,041개(PathInfo 32,455), 150 ms |
| 계약 예산 | 쪽당 200 ms 이하 → 충족(최대 155 ms) |
| 셀 포함 `planPageEditability`(표가 있는 435쪽, 패스 제외) | 중앙값 6.8 ms, p95 26.9 ms, 최대 112 ms(jnl-phwr-2025-18-36-1 11쪽, 셀 314개). M3 쪽 예산 100 ms 를 넘는 쪽 1개 |

- 최적화(2026-10-21): 첫 구현은 kogl-mods-cpi 4쪽 551 ms(구성 연산 193,953개를 토큰 분리). 판정은 `operandRanges` 로 문법만 검사하고 값은 준비 때 읽도록, PathInfo 가 연결된 연산만 순회, BT 상태를 formPath 배열 키로, SMask 를 마지막 gs id 로 기억하도록 바꿔 166 ms(단독 3회 166–168 ms). 코퍼스 스캔에서는 150 ms.

## 4. 편집 가능 비율

### 4.1 패스

측정 2026-10-21(UTC 2026-10-20T16:18), 커밋 `ffa232e` 코드. 항목 = 칠하기 연산(1.1 대상 규칙).

| 문서 | 쪽 | 판정 항목 | 편집 가능 | 비율 | 제한 사유(항목 수) |
|---|---|---|---|---|---|
| arxiv-2609.09268 | 16 | 2,855 | 2,855 | 1.0000 | - |
| arxiv-2609.10511 | 15 | 4,628 | 4,628 | 1.0000 | - |
| fed-combined-finstmt-2025 | 63 | 1,421 | 1,421 | 1.0000 | - |
| fed-h41-current | 11 | 168 | 168 | 1.0000 | - |
| jnl-jdis-2026-2-2-7 | 20 | 424 | 424 | 1.0000 | - |
| jnl-phwr-2025-18-36-1 | 17 | 1,536 | 1,530 | 0.9961 | path-spans-streams 6 |
| kogl-mods-cpi-202609 | 26 | 55,264 | 55,262 | 1.0000 | pattern-or-shading 2 |
| kogl-nabo-finstmt2025 | 179 | 174,019 | 173,897 | 0.9993 | pattern-or-shading 122 |
| kogl-nabo-rnd107 | 103 | 39,568 | 39,527 | 0.9990 | pattern-or-shading 35, path-spans-streams 6 |
| nasa-eo-2019-maraprl | 40 | 636 | 636 | 1.0000 | - |
| nasa-eo-2023-sepoct | 63 | 915 | 915 | 1.0000 | - |
| nasa-eo-2024-janfeb | 34 | 544 | 544 | 1.0000 | - |
| nasa-se-handbook-sp2016-6105 | 297 | 9,448 | 9,444 | 0.9996 | path-spans-streams 4 |
| nist-ai-100-1 | 48 | 198 | 198 | 1.0000 | - |
| nist-cswp29 | 32 | 648 | 648 | 1.0000 | - |
| nist-sp800-171r3 | 120 | 8,671 | 8,671 | 1.0000 | - |
| nist-sp800-53r5 | 492 | 45,326 | 45,322 | 0.9999 | path-spans-streams 4 |
| ustreas-mts-202509 | 40 | 24,091 | 24,091 | 1.0000 | - |
| zen-beamer-10545284 | 54 | 15,634 | 15,615 | 0.9988 | soft-mask 19 |
| zen-beamer-7535020 | 81 | 3,172 | 3,172 | 1.0000 | - |
| zen-ko-kimtw-23386644 | 18 | 0 | 0 | - | - |
| zen-ko-moon-21973474 | 22 | 4,565 | 4,565 | 1.0000 | - |
| zen-ko-report-21333257 | 152 | 2,566 | 2,559 | 0.9973 | path-spans-streams 7 |
| zen-ko-sim-21496576 | 49 | 775 | 775 | 1.0000 | - |
| 합계 | 1,992 | 397,072 | 396,867 | 0.9995 | pattern-or-shading 159, path-spans-streams 27, soft-mask 19 |

### 4.2 표 셀

같은 측정. 셀 = 판정 목록의 셀 항목(셀마다 하나, 빈 셀은 문단이 없어 항목 없음). 셀 하나에 사유가 여럿일 수 있다.

| 문서 | 셀 | 편집 가능 | 비율 | 제한 사유(셀 수) |
|---|---|---|---|---|
| arxiv-2609.09268 | 125 | 125 | 1.0000 | - |
| arxiv-2609.10511 | 49 | 49 | 1.0000 | - |
| fed-combined-finstmt-2025 | 2,300 | 2,299 | 0.9996 | invisible-text 1 |
| fed-h41-current | 693 | 653 | 0.9423 | insertion-clipped 40 |
| jnl-jdis-2026-2-2-7 | 330 | 326 | 0.9879 | insertion-clipped 4 |
| jnl-phwr-2025-18-36-1 | 715 | 715 | 1.0000 | - |
| kogl-mods-cpi-202609 | 3,316 | 27 | 0.0081 | type3-font 3286, remove-skipped 3286, outside-page-content 435, insertion-clipped 3 |
| kogl-nabo-finstmt2025 | 7,185 | 7,185 | 1.0000 | - |
| kogl-nabo-rnd107 | 2,051 | 2,050 | 0.9995 | insertion-clipped 1 |
| nasa-eo-2019-maraprl | 25 | 25 | 1.0000 | - |
| nasa-eo-2023-sepoct | 94 | 94 | 1.0000 | - |
| nasa-eo-2024-janfeb | 30 | 30 | 1.0000 | - |
| nasa-se-handbook-sp2016-6105 | 2,485 | 2,485 | 1.0000 | - |
| nist-ai-100-1 | 100 | 100 | 1.0000 | - |
| nist-cswp29 | 72 | 72 | 1.0000 | - |
| nist-sp800-171r3 | 1,745 | 1,745 | 1.0000 | - |
| nist-sp800-53r5 | 5,160 | 5,160 | 1.0000 | - |
| ustreas-mts-202509 | 12,032 | 12,032 | 1.0000 | - |
| zen-ko-report-21333257 | 1,164 | 1,164 | 1.0000 | - |
| zen-ko-sim-21496576 | 178 | 178 | 1.0000 | - |
| 합계(표 있는 435쪽) | 39,849 | 36,514 | 0.9163 | type3-font 3286, remove-skipped 3286, outside-page-content 435, insertion-clipped 48, invisible-text 1 |

- kogl-mods-cpi-202609 를 빼면 36,487/36,533 = 0.9987. 그 문서 표 글자는 Type3 폰트(`type3-font`·`remove-skipped` 동시)이고 `outside-page-content` 는 Type3 글리프 안 연산이다.
- `insertion-clipped`(48)는 M3 규칙 그대로(직사각형 클립이 원 글자 원점을 덮지 않음, fed-h41 각주 표 등).

## 5. 코퍼스 편집 표본(계약 6.1)

측정 2026-10-21(UTC 2026-10-20T16:21), 커밋 `ffa232e` 코드, 세 엔진(MuPDF·pdf.js·Poppler). 하네스 `packages/pdf-ops/test/m4-corpus.test.ts`(`M4_CORPUS_MODE=render`). 쪽 선정: 벡터 문서는 편집 가능 패스가 가장 많은 2쪽, 표 문서는 레이아웃 표 셀이 가장 많은 2쪽(계약 6.1 의 "도표·표 쪽 2개씩"을 이 규칙으로 고정). 결과 JSON 은 git 밖.

### 5.1 패스(벡터 3문서 6쪽, 쪽마다 편집 가능 패스 큰 것 5개 × 채움 색·선 두께 ×2·10pt 이동)

| 문서 | 쪽 | 편집(건) | 허용 영역 밖 차이(세 엔진) | 쪽 텍스트(MuPDF) |
|---|---|---|---|---|
| arxiv-2609.09268 | 10 | 채움 5·이동 5(선 두께는 선 없는 채움이라 건너뜀 5) | 0 / 0 / 0 | 같음 |
| arxiv-2609.09268 | 14 | 채움 5·선 1·이동 5(건너뜀 4) | 0 / 0 / 0 | 같음 |
| arxiv-2609.10511 | 7 | 채움 5·선 5·이동 5 | 0 / 0 / 0 | 같음 |
| arxiv-2609.10511 | 3 | 채움 5·선 5·이동 5 | 0 / 0 / 0 | 같음 |
| kogl-mods-cpi-202609 | 4 | 채움 5·이동 5(건너뜀 5) | 0 / 0 / 0 | 같음 |
| kogl-mods-cpi-202609 | 6 | 채움 5·이동 5(건너뜀 5) | 0 / 0 / 0 | 같음 |

- 허용 영역 = 편집 전 대상 상자 ∪ `writePathEdit` 반환 상자, 여백 2pt. 76건 모두 0 px. "큰 것 5개"가 모두 채움 전용인 쪽은 선 두께 편집이 없다.

### 5.2 표 셀(표 5문서 중 셀이 있는 4문서 8쪽, 쪽마다 머리 행 셀·숫자 셀·글자 셀 최대 3개 × 같은 텍스트·숫자 자릿수 +1(앞에 "1")·한글 덧붙이기(" 수정"))

| 문서 | 쪽 | 셀(정렬) | 같은 텍스트 원점 이동(pt) | 허용 영역 밖 차이 | 새 텍스트 추출(MuPDF, 같은·숫자·한글) |
|---|---|---|---|---|---|
| ustreas-mts-202509 | 35 | Classification(왼쪽) | 0 | 0 | 3/3 |
| | | 숫자 행(오른쪽, colSpan 14, 여러 열 줄) | 19.24 | 0 | 3/3 |
| | | Receipts:(왼쪽) | 0 | 0 | 3/3 |
| ustreas-mts-202509 | 17 | Classification(왼쪽) | 0 | 0 | 3/3 |
| | | 123(오른쪽) | 0 | 0 | 3/3 |
| | | Gross(가운데) | 0 | 0 | 3/3 |
| fed-h41-current | 9 | Assets, liabilities, and capital(왼쪽) | 0.008 | 0 | 3/3 |
| | | Liabilities(왼쪽) | 0.008 | 0 | 3/3 |
| fed-h41-current | 8 | Assets, liabilities, and capital(왼쪽) | 0.008 | 0 | 3/3 |
| | | Assets(왼쪽) | 0 | 0 | 3/3 |
| fed-combined-finstmt-2025 | 7 | $ 203(왼쪽) | 38.51 | 0 | 3/3 |
| | | Interest income(왼쪽) | 0 | 0 | 3/3 |
| fed-combined-finstmt-2025 | 8 | Reserve Bank Capital(가운데) | 1.004 | 0 | 3/3 |
| | | $ 36,065(왼쪽) | 5.96 | 0 | 2/3 |
| | | Capital paid-in(가운데) | 1.0 | 0 | 2/3 |
| kogl-nabo-finstmt2025 | 107 | 부처(가운데) | 0.002 | 0 | 3/3 |
| | | 34,786(오른쪽) | 2.235 | 0 | 1/3 |
| | | 국토교통부(가운데) | 0.008 | 0 | 2/3 |
| kogl-nabo-finstmt2025 | 85 | 구분(가운데) | 0.002 | 0 | 3/3 |
| | | 100.00 …(오른쪽, 여러 열 줄) | 글자 수 다름 | 0 | 1/3 |

- kogl-mods-cpi-202609 표 쪽(17·18쪽)은 편집 가능 셀이 없어 표본 0건(4.2, Type3).
- 허용 영역 = 셀 상자 ∪ 원 글자 상자 ∪ 배치 상자, 여백 2pt. 60건 모두 세 엔진 0 px.
- 같은 텍스트 원점 이동 ≤ 0.5pt: 20셀 중 13셀(왼쪽 정렬 10셀 중 8셀, 가운데 6셀 중 4셀, 오른쪽 4셀 중 1셀). 넘은 7셀 원인: 가운데·오른쪽 정렬의 리플로우 폭 차이 3셀(1.0·1.0·2.2pt, 6절 7), 같은 기준선 떨어진 조각 2셀(`$` 정렬 5.96·38.5pt, 7절 1), 여러 열 줄을 담은 셀 2셀(19.2pt·글자 수 다름, 7절 2).
- 새 텍스트 추출 실패 7건은 모두 셀 상한에 막힌 초과(`overflow` true, 넘친 줄이 블록 BBox 에서 잘림)다. 초과 표시·경고 상태 커밋은 D5 대로다.

## 6. 계약 불일치·메인 세션 확인

| # | 계약 | 구현 | 근거 | 요청 |
|---|---|---|---|---|
| 1 | D5 셀 시작 영역 가로 = 셀 상자 − 여백(변마다 min(간격, 2pt)) | 정렬한 변은 원 글자 위치(왼쪽 정렬이면 왼쪽 변, 오른쪽이면 오른쪽 변, 가운데면 양쪽 같은 간격). 반대 변·상한은 계약대로 | 계약대로면 왼쪽 정렬 셀의 왼쪽 간격이 2pt 를 넘을 때 같은 텍스트 커밋에서 글자가 왼쪽으로 움직인다(1.1 위치 보존 ≤ 0.5pt 위반) | D5 문구 수정 |
| 2 | D1 셀 안 문단 잇기: 앞 줄이 셀 오른쪽 1em 안까지 차고 줄 간격이 같으면 공백 | 자동 줄바꿈 판정(다음 줄 첫 단어가 앞 줄 뒤에 들어갔는가)으로 공백·`\n`. 문단 사이에 더해 문단 안 줄 사이에도 적용 | 오른쪽 정렬로 쌓은 짧은 숫자 줄은 오른쪽 끝에 닿아 1em 규칙으로는 공백으로 이어지고, 다시 배치되며 위치가 바뀐다. 레이아웃이 셀 안 줄을 한 문단으로 묶으면(M2 문단 텍스트는 줄 사이 공백) 문단 사이 규칙만으로는 줄바꿈이 사라진다 | D1 문구 수정 |
| 3 | D5 상한 = 셀 상자 − 여백 | (셀 상자 − 여백) ∪ 원 글자 상자 | 괘선 표에서 글자가 셀 상자 밖으로 나온 셀(셀 배정은 줄 가운데 기준, ustreas-mts 17쪽 `Gross`·`123`)은 같은 텍스트도 상한에 막혀 초과(overflow-clipped)가 됐다 | D5 문구 수정 |
| 4 | `writePathEdit` 반환 `{ bbox, writeMs }`(시그니처 고정) | 편집 경고(`color-space-changed`·`path-clipped`·`table-rule-removed`)는 새 내보내기 `pathEditWarnings(ctx, prepared)` 로 준다. 기존 시그니처는 그대로 | 경고가 편집 내용에 따라 달라 계획 경고(`PathEditPlan.warnings`)에 넣을 수 없다 | **S2 가 `updatePathDraft` 에서 `pathEditWarnings` 를 불러 `PathDraftUpdate.warnings` 에 합쳐야 함.** 또는 메인 세션이 반환 타입에 `warnings` 를 더함 |
| 5 | `table-rule-removed`: 표 괘선으로 쓰인 패스를 지움 | 삭제한 패스 상자가 괘선 전략(`lines`) 표 상자와 1pt 안에서 겹치면 경고 | `LayoutTable` 에 괘선 패스 목록이 없다(layout-recon 내부 `DetectedTable.paths` 만 있음). 표 안 배경·글상자 패스도 경고된다 | 정확히 하려면 shared-types `LayoutTable.paths` 추가(메인 세션) |
| 6 | 3절 `SourceOp.operandRanges`(숫자·이름 피연산자 범위) | 구성(`m l c v y re h`)·색·`w` 연산만 채운다 | 모든 연산에 넣으면 SourceMap 이 커진다(코퍼스 최대 쪽 연산 260,948개). 패스 편집에 필요한 연산만 | 계약 3절 문구에 범위 명시 |
| 7 | 1.1 위치 보존: 같은 텍스트 셀 편집 글리프 원점 이동 ≤ 0.5pt | 왼쪽 정렬 셀(떨어진 조각 셀 제외)은 0.008pt 이하, 가운데·오른쪽 정렬 셀 중 3셀은 1.0–2.2pt(5.2) | 리플로우 줄 폭은 폰트 전진량 합이고 원문 Tc·Tw·TJ 간격을 모른다. 폭 차이만큼(가운데는 절반) 줄 시작이 움직인다. pdf-ops 시작 영역으로는 고칠 수 없다(리플로우 결과 폭을 판정 시점에 모름) | 리플로우(S4 영역)·D4 모양 정보 확장 여부 결정 |

## 7. 남은 제한

| # | 내용 |
|---|---|
| 1 | 셀 안 같은 기준선의 떨어진 조각(달러 기호 정렬 `$ … 203`, 열 사이 공백이 넓은 한 줄)은 공백 하나로 이어져 다시 배치된다. fed-combined-finstmt-2025 7쪽 `$ 203` 은 같은 텍스트 커밋에서 `$` 가 38.5pt 움직이고, 블록이 다른 열로 감지되어 원 셀이 빈다(V4 셀 대응 실패 1건) |
| 2 | 표 감지가 행 하나의 여러 열을 한 셀로 묶은 경우(ustreas-mts 35쪽 colSpan 14) 셀 편집 대상이 그 행 전체 글이다. 감지 품질 문제(layout-recon M2) |
| 3 | kogl-mods-cpi-202609 표 셀은 대부분 Type3 폰트라 편집 불가(`type3-font`·`remove-skipped`) |
| 4 | 점 편집 대응은 모델 `segments` 가 있을 때만 확인한다. core 가 패스 편집 쪽을 `includePathSegments` 로 추출하지 않으면 MuPDF 경로 단순화(겹친 moveto·길이 0 lineto 생략 등)와 어긋난 점 번호를 걸러내지 못한다 |
| 5 | `path-clipped` 는 직사각형 클립만 본다. 비직사각형 클립 안 패스는 경고 없이 잘릴 수 있다 |
| 6 | `shared-form` 은 이 쪽 사용 경로 수와 쪽 Resources 의 직접 참조만 센다. 다른 Form 안에서만 쓰이는 공유는 세지 않는다(복제는 항상 하므로 쓰기 결과는 같다) |
| 7 | 삭제는 구성 ~ 칠하기 사이 공백·주석까지 공백 하나로 바꾼다(리뷰 L1, 이전 `n`) |

## 8. 검증

2026-10-21, 이 worktree `m4-pdf-ops`(커밋 `0e2cdf1` + 이 문서).

| 명령 | 결과 |
|---|---|
| `pnpm exec turbo run build typecheck test --force` | 통과(24개 작업, 캐시 0, 종료 코드 0) |
| 단위 | shared-types 4, layout-recon 60(3 skip), reflow 55, pdf-ops 424(5 skip), core 220(4 skip), viewer-ui 234, extension 43, spike-m0 33(1 skip) |
| `pnpm lint`·`pnpm exec prettier --check .` | 통과 |

- 새 시험: pdf-ops `path-edit.test.ts` 25건(인터프리터 필드·판정·쓰기·점 편집·Form·공유 /Contents·지문·경고·V2·V3 합성 세 엔진), `cell-edit.test.ts` 9건(셀 대상·판정 목록·줄 잇기·정렬 전략·실제 리플로우 커밋 위치 보존·세 엔진·V4 2건·자동 확장 상한·R-L4), layout-recon `reconstruct.test.ts` 4건(V4). `paragraph-plan.test.ts` 표 셀 시험을 M4 규칙으로 갱신.
- 코퍼스 하네스(옵트인, git 밖 결과): `M4_CORPUS_DIR=/mnt/nas4/kjune/pdf-editor/fixtures/corpus M4_CORPUS_MODE=scan|render M4_CORPUS_OUT=<접두> npx vitest run test/m4-corpus.test.ts`(pdf-ops 폴더). scan 89초, render 약 3분.
- R-L4 시험은 수정 전 경로(바뀐 스트림을 옛 범위로 다시 읽음)로 되돌리면 실패한다(새 텍스트 색이 파랑이 아님, 2026-10-21 확인).
