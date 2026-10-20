# M4 통합 결과

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-21 |
| 범위 | `docs/m4-contract.md` 작업 S1–S4 머지 뒤 통합: 계약 불일치 #4·#5·#7(`docs/m4-pdf-ops.md` 6절), 시작 상태 충실도(`docs/m3-integration.md` 10.4 제안 1·2), R-L3 연결, 통합 e2e, 실제 어댑터 시험, 코퍼스 표본(6.1), V5 |
| 기준 | `m4` 브랜치 20f823b(네 작업 브랜치 머지) 이후 커밋. 계약 수정 2(6ae4fc7, 메인 세션) |
| 측정 환경 | 서버 `sailab01`, Node 22.18, npm `mupdf` 1.28.1, pdfjs-dist 6.4.299, Poppler 22.02, Playwright 1.64.1 번들 Chromium 156. Windows Chrome 은 미측정 |

## 1. 머지

| 순서 | 브랜치 | 머지 커밋 | 작업 문서 |
| --- | --- | --- | --- |
| 1 | `m4-pdf-ops`(S1) | ac9bf0f | `docs/m4-pdf-ops.md` |
| 2 | `m4-core`(S2) | 44dfa5d | `docs/m4-core.md` |
| 3 | `m4-viewer-ui`(S3) | cff18cd | `docs/m4-viewer-ui.md` |
| 4 | `m4-m3fu`(S4) | 20f823b | `docs/m3-integration.md` 10절 |

- main 머지 c2e0251(origin/main 0877dfc, PR #6 도형 라벨 문단 편집 허용). 충돌 3곳: `edit-plan.ts` 는 m4 셀 판정(`cellTarget`)을 살리고 main 의 "표 셀만 `not-flow-paragraph`" 규칙은 M4 셀 편집으로 대체해 `not-flow-paragraph` 를 어디에도 붙이지 않는다. `paragraph-plan.test.ts` 는 표 문단(셀 없음)도 제한 없음 시험으로, main 의 도형 라벨 편집 가능 시험은 그대로. `edit-labels.ts` 는 m4 타입(패스 사유 포함)에 문구를 "본문 흐름 밖의 글자…"(이전 결과 표시용)로. shared-types 사유 주석 갱신.

## 2. 통합 수정

### 2.1 계약 불일치

| # | 내용 | 처리 | 시험 |
| --- | --- | --- | --- |
| #4 | 패스 쓰기 경고(`color-space-changed`·`path-clipped`·`table-rule-removed`)가 `pathEditWarnings` 로만 나옴 | 기본 어댑터 `writePathEdit` 가 `pathEditWarnings` 를 반환 `warnings` 에 싣는다. core 는 어댑터가 `warnings` 를 주면(빈 배열 포함) 그것만 쓰고, 없을 때만 core 근사(`pathCoreWarnings`)를 쓴다(같은 종류는 하나). "M4 미구현" 삼킴 제거 | `edit-path.test.ts` 1건(근사 비사용·종류 중복 제거), `edit-real-m4.test.ts` DeviceGray→RGB 경고 |
| #5 | `LayoutTable` 에 괘선 패스 목록이 없어 표 상자와 겹친 모든 삭제에 경고 | shared-types `LayoutTable.paths: number[]`(표 상자 안 괘선·배경 사각형 PageModel.paths 인덱스) 추가, `reconstruct` 가 `DetectedTable.paths` 를 싣는다. pdf-ops 는 삭제한 칠하기 연산의 PathInfo 중 하나가 `lines` 전략 표의 `paths` 에 있을 때만 경고 | pdf-ops `path-edit.test.ts` 1건(표 모서리를 걸친 사선 삭제는 경고 없음), `edit-real-m4.test.ts` 1건. 시험 픽스처 4곳 갱신 |
| #7 | 같은 텍스트 셀 편집에서 가운데·오른쪽 정렬 셀 3개가 1.0–2.2pt 이동 | 2.2 의 시작 상태 수정 + 셀 정렬 변을 보이는 글자 잉크 기준으로(`cellTarget`): 문단 상자가 줄 끝 공백 글리프까지 덮어 리플로우 줄(줄 끝 공백 제외)이 공백 폭(가운데는 절반)만큼 밀렸다. 정렬 판정은 문단 상자 그대로 | `start-fidelity.test.ts` 셀 1건(수정 전 경로로 되돌리면 실패 확인) |

- M2 정확도 하네스(`LAYOUT_CORPUS_DIR`, dev): 문단 F1 0.8998(변화 없음), 표 P·R 1·1, 표 모양 1.

### 2.2 시작 상태 충실도(S4 제안 C1·C2)

| 항목 | 설계 |
| --- | --- |
| 자간 | `RunStyle.charSpacing?`(pt, 페이지 공간) = 원본 연산 `Tc` × `Tz`/100 × 글자 공간 → 페이지 공간 가로 배율. `FontSegment.charSpacing` 으로 리플로우가 클러스터 전진에 글리프마다 더하고, 줄 끝 글리프 뒤 자간은 줄 폭에서 뺀다(`kernAfter`). 쓰기는 위치 차이를 TJ 숫자로 옮기므로 블록은 `0 Tc` 그대로다 |
| 가로 비율 | `RunStyle.horizontalScale?` = `Tz`/100 × (가로 배율² / \|det\|). Tm·CTM 으로 가로만 줄인 글자(HWP 계열)도 같은 값. 기울인 글자(Tm 비틀기)는 1. 리플로우가 전진·커닝에 곱하고 `WritableGlyph.horizontalScale` 로 넘기며, 쓰기가 편집 블록에 `Tz` 를 쓰고 TJ 단위·펜 전진에 곱한다 |
| 자간 띄어쓰기 | 같은 줄 두 원본 글자 사이에 합성 공백(추출이 넓은 간격에 넣은 것)이 있는 모양 구간은 양수 자간을 싣지 않는다(간격 이중 계산 방지, ustreas-mts 1쪽 머리글·kogl-nabo-rnd107 4쪽) |
| 영역 가로 보정 | `planParagraphEdit`(편집 블록 아님)에서 원 줄 경계마다 강제 줄바꿈을 넣은 텍스트를 넓은 영역에 배치해 원 줄 자연 폭(첫 줄 들여쓰기 포함)의 최댓값을 잰다. 영역 폭보다 크면 정렬 반대 변(가운데는 양쪽)으로 넓힌다. 상한 = `areaLimit` ∩ 이웃 내용(대상 밖 문단·이미지·칠하기 패스 중 세로로 걸치고 원 영역과 겹치지 않는 것) 앞 0.5pt. 배정은 판정 시점 해석(`resolveStyle`)으로 한다 |
| 호환·결정성 | 두 필드는 선택이며 없으면 0·1(이전 로그·블록). 값은 유효숫자 6자리, 영역 증가는 소수 3자리로 고정. `/PdfEditorFormat` 구간에도 저장해 재편집 때 되살린다. 재적용은 로그의 `runs`·`format` 을 쓰므로 판정 결과에 의존하지 않는다 |

- 시험: reflow `layout.test.ts` 3건, pdf-ops `start-fidelity.test.ts` 11건(Tc·Tz·Tm 가로 축소·기울임·자간 띄어쓰기·블록 재편집 복원·TJ 커닝 영역 보정·이웃 상한·셀 잉크 정렬). Tc·영역 보정 시험은 수정 전 경로로 되돌리면 실패한다(4/6 실패 확인).

### 2.3 R-L3 해제 연결·WASM 해제

| 항목 | 내용 |
| --- | --- |
| pdf-ops | `FontManager.dispose()`(→ `FontState.dispose`), `releaseEdit(doc, editId?)`(문단 WriteContext·패스 준비 상태 버림) |
| core | 초안 종료(문단·패스 커밋·취소·실패 정리)와 재적용 한 건마다 `releaseEdit(doc)`(문서당 초안 하나라 문서 전체), `dispose()`(세션 close)에서 `releaseEdit` + `FontManager.dispose`. 폴백 로드가 늦게 성공해 FontManager 를 바꿀 때도 해제 |
| WASM 사본 | mupdf.js 는 `Uint8Array` 를 받으면 임시 `Buffer` 래퍼를 만들고 해제를 GC 에 맡긴다. 폴백 폰트(4 MB)·문서 바이트·콘텐츠 스트림 쓰기를 직접 만든 버퍼로 바꾸고 바로 해제(`fontFromBytes`·`openFromBuffer`·`writeStreamBytes`). Device 추출의 글꼴 래퍼(mupdf.js 가 글꼴이 바뀔 때마다 만듦)는 추출 끝에 해제. 폴백 임베딩 뒤 `mupdf.Font` 해제 |
| 측정 | 열기 → 문단 편집(한글) → 패스 편집 → 저장 → 닫기 순환: 수정 전 12회에 WASM 힙 +179 MB(69 → 248 MB), 수정 후 40회 33 → 40 MB. `edit-real-m4.test.ts` 가 12회 증가 < 16 MB 를 단언 |

- 편집 쪽 상태 모델을 세그먼트 포함 추출로 바꿨다(`session.ts` `pageState`). 레이아웃이 이미 만든 캐시를 쓰므로 추출이 줄고, pdf-ops 점 편집이 점 번호를 모델 세그먼트로 대조한다(`docs/m4-pdf-ops.md` 7절 #4).

### 2.4 뷰어

| 항목 | 내용 |
| --- | --- |
| Alt+클릭 선택 | `selectAt` 이 패스 모델과 함께 쪽 판정 도착을 기다린다(`ensureEditability` 가 같은 쪽 진행 중 요청을 기다림). 판정 전 클릭이 후보 없음으로 선택을 지우던 경합 |
| 통합 e2e | `path-integration.spec.ts` 5건 활성화. 시험 쪽 보정: 열기 뒤 쪽 판정 준비 대기, Alt+클릭을 선택 상자가 보일 때까지 재시도(열린 직후 패스 모델 재적재와 겹친 첫 클릭이 사라짐, 2.4 남은 제한), Worker 복구 시험을 M3 와 같은 방식(편집 두 번 → undo 중 렌더 실패 → 남은 `EditPathOp` 재적용 = 첫 편집 화면)으로 바꿈(복구 뒤 redo 이력이 없어 기존 본문은 redo 클릭에서 멈춤) |

## 3. 실제 어댑터 core 시험(`packages/core/test/edit-real-m4.test.ts`, 14건)

| 묶음 | 내용 |
| --- | --- |
| 셀(4) | 괘선 표 셀 D1 편집 → V4(표 1개·모양 유지, 셀 문단 하나, `table` 설정) → undo/redo → 저장·재열기 → 같은 셀 재편집(`editedBlock`·`cell` 유지). 정렬 전략 표 V4. 같은 텍스트 셀 3개 원점 이동 ≤ 0.5pt. `table-rule-removed` 는 격자 패스만 |
| 패스(9) | 판정 4개 가능, 이동·크기(`re` 유지, 다른 패스 불변), 점 편집(가운데 점만, 상자 위 변 30pt), 색(DeviceGray→RGB 경고·같은 공간 경고 없음), 선 두께 6pt·삭제(`n`), 다중 선택 이동 + undo/redo(콘텐츠 바이트 일치), 재적용 결정성(두 새 문서 콘텐츠 바이트·패스 = 원래, 지문 바꾸면 실패), 문단 편집이 뒤 패스 paintSeq 를 +1 민 뒤의 패스 편집 재적용, 저장·재열기 뒤 재편집 |
| R-L3(1) | 2.3 순환 힙 |

## 4. 측정

### 4.1 M3 코퍼스 하네스(계약 M3 8.2, 330건, 세 엔진)

| 지표 | M3 통합(after-justify) | M4 통합 |
| --- | --- | --- |
| 같은 텍스트 편집에서 아래 변이 원 bbox 아래로 내려감 | 26/110 → S4 뒤 23/110 | **2/110**(C6 fed-h41 1쪽 #2, C7 arxiv-2609.09268 1쪽 #2) |
| 상한 초과(`overflowFinal`) | 29 | 3 |
| 텍스트(엄격, MuPDF / pdf.js) | 228 / 239 | 240 / 248 |
| 같은 텍스트 텍스트(엄격) | 102 / 103 | 110 / 110 |
| 영역 밖 렌더 0 px(세 엔진)·다른 쪽·객체 | 330·330·330 | 330·330·330 |
| 새 글자 잉크 | 324 | 321 |
| 검색·순서(MuPDF pass) | 328·243 | 328·243 |

- 잉크 차이 4건(늘어남 4, 줄어듦 1): 렌더는 같다. nasa-eo-2019-maraprl 4쪽 #6 같은 텍스트·한글은 기울임체 `’` 의 잉크가 전진 상자(1.9pt) 밖에 있다(원본과 화면 같음, 판정 상자 한계). 같은 문서 1쪽 #22·nasa-eo-2024-janfeb 1쪽 #4 한글 덧붙이기는 자동 확장한 셋째 줄이 뒤에 그려진 머리 띠·그림에 가린다(`area-overlaps-content` 경고, M3 와 같은 겹침에서 글자 위치만 달라짐).

### 4.2 M4 코퍼스 표본(계약 6.1, `edit-corpus-dod.test.ts` `EDIT_CORPUS_M4=cells,paths`, 123건, 4분)

| 지표 | 셀(63건: 8쪽 21셀 × 3종) | 패스(60건: 6쪽 30패스, 채움 19·선 11·이동 30) |
| --- | --- | --- |
| 오류 | 0 | 0 |
| 허용 영역 밖 렌더 0 px(MuPDF·pdf.js·Poppler) | 63·63·63 | 60·60·60 |
| 다른 쪽 렌더 0 px·다른 쪽 객체 불변 | 63·63 | 60·60 |
| 텍스트(셀: 배치 상자 = 입력, 패스: 쪽 텍스트 불변) | MuPDF 59/63, pdf.js 60/63 | MuPDF 60/60 |
| 재적용 결정성(새 세션 replayEdits 저장 렌더 = 원래) | 63/63 | 60/60 |
| 같은 텍스트 원점 이동 ≤ 0.5pt | 17/21(S1 측정 13/20) | — |
| V4(표 모양 유지·셀 문단 하나·`table`) | 57/63 | — |
| 경고 | `font-fallback` 22, `overflow-clipped` 18, `tagged-structure-kept` 18, `synthetic-style` 10 | `color-space-changed` 15, `path-clipped` 6 |
| 갱신 시간(`updateMs`) | — | 중앙 40, p95 83, 최대 86 ms |

- 판정 비율(표본 쪽 전체): 셀 1872/2705(0.692, 사유 `type3-font`·`remove-skipped` 각 802 — kogl-mods-cpi Type3, `outside-page-content` 82, `insertion-clipped` 31), 패스 44887/44887(1.0).
- 실패 분류: 텍스트 4건은 모두 한글 덧붙이기의 셀 상한 초과(넘친 줄이 블록 BBox 에서 잘림, D5 경고 커밋). 원점 이동 4건과 V4 6건은 레이아웃 감지 한계 두 셀: 같은 기준선 떨어진 조각 `$ 203`(38.5pt)·`$ 36,065`(5.96pt), 여러 열을 한 셀로 묶은 행(ustreas 35쪽 19.2pt, kogl-nabo-finstmt2025 85쪽 글자 수 다름)(`docs/m4-pdf-ops.md` 7절 #1·#2). `$ 203`·kogl-nabo 85쪽 셀은 커밋 뒤 셀이 비어 V4 실패.
- 불일치 #7 셀: fed-combined 8쪽 `Reserve Bank Capital` 1.004 → 0.004pt, `Capital paid-in` 1.0 → 0.008pt, kogl-nabo-finstmt2025 107쪽 `34,786` 2.235 → 0.121pt(Tm 가로 축소 0.89).
- pdf-ops S1 하네스(`m4-corpus.test.ts` render) 재측정: 393 렌더 비교 모두 0 px, 새 텍스트 추출 127/131.

### 4.3 V5·성능

core(`scripts/measure-m4.mjs drag`, 편집 가능 패스 큰 것 10개 × 50 단계 0.5pt 이동, 단계 = `updatePathDraft` 스트림 다시 쓰기 + 영역 렌더):

| 쪽 | 패스(편집 가능) | 배율 2 p50 / p95 / 최대 | 배율 1 p50 / p95 | 쪽 판정 | 계획·시작·커밋 |
| --- | --- | --- | --- | --- | --- |
| kogl-mods-cpi-202609 4쪽(코퍼스 최대) | 32041 | 82.5 / 89.3 / 102.5 ms | 78.0 / 82.0 | 1750 ms | 6.6 · 21.8 · 0.9 ms |
| kogl-nabo-finstmt2025 153쪽 | 9004 | 17.8 / 26.9 / 36.4 | 16.6 / 18.1 | 502 ms | 0.9 · 4.6 · 0.9 |
| arxiv-2609.10511 7쪽 | 3190 | 37.4 / 39.7 / 49.1 | 28.0 / 29.9 | 612 ms | 3.1 · 9.4 · 0.9 |
| arxiv-2609.09268 10쪽 | 1086 | 33.4 / 36.9 / 48.9 | 23.9 / 25.3 | 512 ms | 31.1 · 29.0 · 0.9 |

- 콘텐츠 스트림 쓰기 버퍼를 직접 해제하기 전 최대 패스 쪽 p95 는 216 ms 였다(3.8 MB 사본이 GC 전까지 쌓여 멈춤). 수정 뒤 92 ms 안.
- 쪽 판정 시간은 계약 4.2 의 쪽당 200 ms 를 넘는다(최대 패스 쪽 1.75 s, 추출·SourceMap·레이아웃 포함, `docs/m4-core.md` 4.3·6절 #12).

Playwright(계약 6.2, `e2e/path-latency.spec.ts` 옵트인, kogl-mods-cpi 4쪽, cssScale 1.5, 고정 패스 10개 선택 → 50 단계 끌기, 단계 사이 30 ms):

| 지표 | 값 |
| --- | --- |
| 단계 입력 → 합성(두 번째 rAF) | p50 50.7, p95 51.5, 최대 67.3 ms(CDP 왕복 포함) |
| 놓기 → 커밋(되돌리기 활성) | 208 ms |
| 통합 e2e 소형 문서 정지 갱신 p95 | 20–24 ms(3회) |

## 5. 검증

2026-10-21, 이 worktree `m4`, main 머지(c2e0251) 뒤.

| 명령 | 결과 |
| --- | --- |
| `pnpm exec turbo run build typecheck test test:e2e --force` | 통과(25개 작업, 캐시 0, 종료 코드 0) |
| 단위 | shared-types 4, layout-recon 60(3 skip), reflow 60, pdf-ops 440(5 skip), core 275(5 skip), viewer-ui 280, extension 44, spike-m0 33(1 skip) |
| e2e | 119건 통과, 3건 skip(옵트인 측정 `edit-latency`·`path-latency`, 기존 동적 skip) |
| `pnpm lint`·`pnpm exec prettier --check .` | 통과 |
| `path-integration.spec.ts --repeat-each=3` | 15/15 통과 |

## 6. 계약 확인 요청(메인 세션)

| # | 계약 | 구현 | 요청 |
| --- | --- | --- | --- |
| 1 | D5 수정 2: 원문 자간은 "쓰기는 블록에 `Tc` 로 쓴다" | 쓰기는 리플로우 글리프 위치 차이를 TJ 숫자로 쓰고 블록은 `0 Tc` 그대로 | 위치는 같다. 문구를 "위치 차이로 쓴다"로 맞출지 결정 |
| 2 | shared-types 3절 | `RunStyle.horizontalScale?` 추가(Tz·Tm 가로 축소). 불일치 #7 의 오른쪽 정렬 셀 2.2pt 원인 | 3절 표에 추가 |
| 3 | `LayoutTable.paths` | 필수 필드(`lines`·`text` 두 전략 모두 채움, 판정은 `lines` 만) | 확인 |
| 4 | 4.2 판정 시간 쪽당 200 ms | 최대 패스 쪽 1.75 s(4.3) | 기준에서 추출·SourceMap·레이아웃 제외 여부(`docs/m4-core.md` 6절 #12) |

## 7. 남은 제한

| # | 내용 |
| --- | --- |
| 1 | 글자쌍 커닝(TJ)은 시작 상태에 싣지 않는다. 영역 보정은 줄바꿈만 지키고 글자 위치는 셰이퍼 폭으로 놓인다(같은 텍스트에서 줄 안 글자가 커닝 양만큼 움직임). 이웃 내용이 가까우면 보정이 멈춰 일찍 줄바꿈될 수 있다 |
| 2 | 같은 텍스트 아래 변 내려감 2건: C6(시작 영역 위 변이 `areaLimit` 밖, S4 제안 5 미적용), C7(위첨자 상승·기호 폰트 내림) |
| 3 | 셀: 같은 기준선 떨어진 조각·여러 열을 묶은 셀(레이아웃 감지 한계)은 원점 이동·V4 실패. 한글 덧붙이기는 셀 상한 초과 시 잘린다(D5 경고 커밋) |
| 4 | 쪽 판정 시간: 최대 패스 쪽 1.75 s(4.3). 최대 패스 쪽 `updatePathDraft` 최대 102 ms(p95 89 ms) |
| 5 | 뷰어: 문서를 연 직후 패스 모델 재적재와 겹친 첫 Alt+클릭은 선택 없이 끝날 수 있다(e2e 는 재시도). 원인(재적재 계기) 미조사 |
| 6 | 자간 띄어쓰기 판정은 양수 자간 + 같은 줄 합성 공백 기준이다. 합성 공백이 없는 넓은 양수 자간은 그대로 싣는다 |
| 7 | 코퍼스 표본 쪽은 S1 표본 쪽을 고정해 썼다(셀 10쪽 중 셀이 있는 8쪽·패스 6쪽). kogl-mods-cpi 표 쪽(17·18쪽)은 편집 가능 셀 0 |

## 8. 리뷰 반영

M4 마일스톤 리뷰(2026-10-21) 지적 반영. 시험 이름은 해당 파일의 `it` 제목이다.

| 지적 | 내용 | 수정 | 시험 |
| --- | --- | --- | --- |
| H1 | `/Resources` 없는 Form 안 패스를 고치면 복제본 `/Resources` 가 빈 사전이 되어 pdf.js 가 Form 글자를 대체 폰트로 그림(3215 px 차이) | `path-edit.ts` `formHolder`: 원본 Form 에 `/Resources` 가 없으면 부르는 쪽 유효 Resources(상위 Form 복제본, 없으면 쪽 상속 Resources) 사본을 복제본 소유로 둔다. 편집 가능 유지(차단 사유 추가 안 함) | `pdf-ops/test/path-edit.test.ts` "Resources 없는 Form(쪽 상속)"·"Resources 없는 Form(상위 Form 상속)": 세 엔진(MuPDF·pdf.js·Poppler) 편집 상자 밖 0 px, 복제본 Resources 에 원래 폰트 이름 |
| M1 | `beginPathEdit` 가 고정 교체 없는 쪽 `/Contents` 칸도 다시 써서 변경 없이 취소해도 redo 가 사라짐 | `preparePathEdit`: 고정 교체가 있는 칸과 Form 복제본만 쓴다. 첫 쓰기는 `writePathEdit` | `core/test/edit-real-m4.test.ts` "redo 보존(리뷰 M1)": 커밋 → undo(canRedo) → 시작 → 갱신 없이 취소 → canRedo 유지·redo 동작. 갱신 뒤 취소는 redo 가 사라짐(문서화된 동작). `docs/m4-core.md` 5절 #7 정정 |
| M2 | 실패 상태 저장 경고가 사용자에게 가지 않음 | shared-types `SavePlan.warnings?`·`SaveResult.warnings?`. core `saveWarnings()` 두 줄(엔진 오류 사유, 마지막 편집 누락·일부 반영·취소한 초안 변경 포함 가능). 실패 상태 저장도 폴백 서브셋 교체·서브셋 이름 태그(R-L2)를 최선 노력으로 함(오류 무시). 뷰어 `decideSave` 가 core 경고를 확인 창 맨 앞에 넣는다 | `core/test/edit-m3-followup.test.ts` R-M4 경고 2줄·"실패 상태 저장도 폴백 서브셋 교체·이름 태그"(태그 이름, 서브셋 크기 < 원본, 재저장 같은 이름). `extension/test/save-plan.test.ts` "core 저장 경고…확인 창"·"over-limit 이면 core 경고가 있어도 중단" |
| M3 | 패스 동작의 revision 재시도·복구 재시작이 다시 계획한 대상을 확인하지 않음 | `path-gesture.ts`: 재계획 결과의 `target.paintSeqs`·`fingerprints` 를 직전 계획과 비교(pdf-ops `sameFingerprint` 규칙). 다르면 `PathTargetChangedError` 로 시작·커밋하지 않고, `PathController` 가 선택을 푼다 | `viewer-ui/test/path-controller.test.ts` "revision 재시도에서 대상 지문이 바뀌었으면…"·"Worker 복구 재시작에서 대상 지문이 바뀌었으면…" |
| M4 | 패스 판정 오류가 `getPageEditability` 전체를 실패시켜 문단 편집까지 막음 | `EditEngine.#planPaths`: 오류를 `paths: []` + `PageEditability.pathError`(shared-types 선택 필드, 진단)로 격리, 문단 판정은 그대로. 뷰어는 `path-editability-error` 진단 로그 | `core/test/edit-path.test.ts` "패스 판정 오류는 패스만 비우고 문단 판정은 돌려준다"(던지는 어댑터 주입)·"정상 판정에는 pathError 가 없다" |
| L1 | 삭제가 구성 ~ 칠하기를 짝 없는 `n` 으로 바꿈(엄격한 프리플라이트) | 공백 하나로 바꾼다. 뒤 칠하기의 paintSeq 는 하나씩 당겨지고 대상 확인은 지문(D4)이 맡는다(`path-edit.ts` 머리 주석, `docs/m4-pdf-ops.md`·`docs/m4-contract.md` 패스 삭제 항목) | `pdf-ops/test/path-edit.test.ts` "삭제: 구성 ~ 칠하기를 공백으로…"(뒤 패스 재판정·편집 가능)·"삭제: Form 안·q/Q 사이·연속 삭제도…"(세 엔진 0 px). `core/test/edit-real-m4.test.ts` 선 두께와 삭제 |
| L6 | 뷰어 선 두께 입력이 긋지 않는 패스에도 켜지고, 바뀌는 것 없는 편집도 저널에 남음 | `PathController.selectionPaints()`(패스 모델 `PathInfo.op`)로 채움 색·선 색·선 두께 입력을 켠다. `effectiveEdit()` 가 해당 없는 칠하기·현재 값과 같은 값을 빼고 남는 것이 없으면 초안을 열지 않는다. `PathGesture.commit()` 은 항등 변환 등 무변경 편집을 취소로 처리 | `viewer-ui/test/path-controller.test.ts` "바뀌는 것이 없는 속성 편집은 초안을 열지 않는다"·"선 두께는 긋는 패스에만…"·"제자리로 돌아온 끌기(항등 변환)는…" |

### 8.1 후속(이번에 고치지 않음)

리뷰 보고서의 다음 지적은 기록만 하고 이후 작업으로 둔다. 내용은 리뷰 보고서(메인 세션)를 따른다.

| 지적 | 처리 |
| --- | --- |
| L2 | 후속 |
| L3 | 후속 |
| L4 | 후속 |
| L5 | 후속 |
| L7 | 후속 |
| L8 | 후속 |

### 8.2 검증

2026-10-21, 이 worktree `m4`, 리뷰 반영 커밋 뒤.

| 명령 | 결과 |
| --- | --- |
| `pnpm exec turbo run build typecheck test test:e2e --force` | 통과(25개 작업, 종료 코드 0) |
| 단위 | shared-types 4, layout-recon 60(3 skip), reflow 60, pdf-ops 443(5 skip), core 278(5 skip), viewer-ui 285, extension 46, spike-m0 33(1 skip) |
| e2e | 119건 통과, 3건 skip(옵트인 측정·기존 동적 skip) |
| `pnpm lint`·`pnpm exec prettier --check .` | 통과 |
