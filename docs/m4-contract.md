# M4 계약: 표 셀 텍스트 · 벡터 패스 편집 · 편집 가능 표시

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-20 |
| 범위 | PLAN.md 6절 M4(표/도표 편집) 병렬 구현의 공통 기준 |
| 기준 | `m4` 브랜치 계약 커밋(이 문서, `packages/shared-types/src/edit.ts`·`rpc.ts`·`source-map.ts` 추가분, pdf-ops·core 연결부). 모든 M4 작업은 이 커밋에서 시작한다 |
| 변경 권한 | `packages/shared-types`, pdf-ops `path-edit.ts` 의 내보낸 시그니처, 루트 설정, `pnpm-lock.yaml`, 새 의존성은 메인 세션만 바꾼다(PLAN.md 10절) |
| 입력 | M3 계약(`docs/m3-contract.md`, 수정 1–6)·통합 결과(`docs/m3-integration.md`), M2 계약(PageLayout 표 모델), M1 계약(SourceMap·paintSeq) |
| 일정 | PLAN.md 6절 계획은 3주(2027-01-18~02-07). 2026-10-20 착수 |
| 상태 표기 | 확정·권고·결정 대기(M3 계약과 같음) |
| 변경 이력 | 초판 + 독립 검토 반영(2026-10-20) |
| 독립 검토 | 2026-10-20 읽기 전용 검토(판정 REVISE: BLOCKER 1·HIGH 6·MEDIUM 8·LOW 9)를 이 판에 반영했다. 실측(MuPDF): 경로 안 끼인 `w`·`Q` 가 새 속성을 무시·상태 누출, 편집 블록 `Do` 가 뒤 패스 paintSeq 를 +1 민다 |

## 1. 완료 기준과 범위

### 1.1 M4 완료 기준(DoD)

| 축 | 기준 | 측정 |
| --- | --- | --- |
| 셀 편집 | 표 셀 텍스트를 M3 문단 편집과 같은 흐름(편집 → 리플로우 → 초과 처리 → 저장)으로 고친다. 표 괘선·배경·다른 셀은 바뀌지 않는다 | 코퍼스 표 쪽 편집 표본(8.1) |
| 벡터 편집 | 편집 가능 판정을 통과한 패스의 위치·크기(D2), 선 두께, 선·채움 색을 바꾼다. 다른 패스·글자는 바뀌지 않는다 | 합성 PDF·코퍼스 도표 쪽 표본 |
| 시각 | 변경 허용 영역(셀: 셀 상자 ∪ 배치 상자, 패스: 편집 전·후 패스 상자, 여백 2pt) 밖 렌더 변화 0 px, 다른 쪽 0 px. MuPDF·pdf.js·Poppler | 8.1 |
| 텍스트 | 셀: M3 1.1 텍스트·검색·순서 기준. 패스 편집 뒤 쪽 텍스트 추출 불변 | 8.1 |
| 객체 | 편집하지 않은 쪽 객체 불변. 패스 편집은 원 패스 연산의 바이트와 그 앞뒤 삽입만 바꾼다(공유 /Contents 는 사본, Form 안은 복제본에서) | 객체 diff |
| 위치 보존 | 셀을 같은 텍스트로 편집했을 때 글리프 원점 이동 ≤ 0.5pt(정렬·영역 복원 검증) | 8.1 |
| 편집 동작 | 셀·패스 편집의 undo/redo, 연속 편집, 저장 후 재편집, 재적용 결정성 | 단위·Playwright |
| 편집 가능 표시 | 쪽 전체 표시 토글로 문단·셀·패스의 편집 가능 여부(색 구분)와 사유를 본다 | Playwright |
| 성능 | 패스 끌기 미리보기 반응 p95 100 ms 이하(서버 Chromium, 8.2) | Playwright |

### 1.2 이관 항목(M3 후속, M4 첫 주에 함께 처리)

| 항목 | 출처 | 처리 |
| --- | --- | --- |
| 같은 텍스트 교체가 원 bbox 를 넘는 문단 26/110(원인 1개 확인: TeX 덧쓰기 악센트) | `docs/m3-integration.md` 7절 #1 | 작업 S4 |
| 편집기가 열리는 동안 입력 소실 | 같은 절 #3 | 작업 S3 |
| R-M4: `#failure` 상태에서 저장도 막힘(편집 손실) | M3 마일스톤 리뷰(2026-10-20, 아래 R- 항목 출처) | 작업 S2 |
| R-L5: 폴백 폰트 로드 실패 시 편집 기능 전체 꺼짐 | 같은 리뷰 | 작업 S2 |
| R-L2: 폴백 서브셋 뒤 `/BaseFont` 서브셋 태그 없음 | 같은 리뷰 | 작업 S2(`core/src/edit-engine.ts`·pdf-ops `font-embed.ts` 는 S2 가 S1 과 조율) |
| R-L3: OriginalFont·폴백 `mupdf.Font`·WriteContext 해제 없음 | 같은 리뷰 | 작업 S4(`font-assign.ts`), core 호출부는 S2 |
| R-L4: `edit-block.ts` `styleOf` 대체 경로가 바뀐 스트림을 옛 범위로 읽음 | 같은 리뷰 | 작업 S1 |
| R-L1: 뷰어 `ResilientPdf.beginParagraphEdit` 가 `renderScale` 을 넘기지 않음 | 같은 리뷰 | 작업 S3 |

- R- 항목: M3 읽기 전용 마일스톤 리뷰의 MEDIUM 4(R-M4)·LOW 1–5(R-L1–R-L5). PLAN.md 3.4 의 Form 제한 L1–L7 과 다르다. 원문 요약은 `docs/m3-integration.md` 8절 뒤에 이 계약 커밋에서 덧붙인다.
| 표 셀 편집용 코퍼스 보강(A7-10) | PLAN.md 8절 | 메인 세션(8.1 표본 선정 때) |
| 표 격자 오버레이를 병합 셀 기준으로(W4-6) | `docs/m2-accuracy.md` 7.1 | 작업 S3 |

### 1.3 범위 밖(M4)

- 표 행·열 추가·삭제·병합·분할, 행 높이·열 너비 바꾸기(PLAN.md 1.2).
- 차트 데이터·축·범례 연동 수정(PLAN.md 1.2). 패스는 그래픽 단위로만 고친다.
- 패스 점 단위 편집(꼭짓점·제어점)(D2 결정 대기).
- 클립 패스, 패턴·셰이딩 채움 패스의 편집(4.2 제한), 이미지 편집.
- 새 패스 그리기, 패스 삭제(D2 결정 대기).
- 빈 셀(글자 0)의 편집: 삽입점·모양 원본이 없다(후속).
- 패스가 아닌 칠하기 소유자: Form `Do` BBox 클립, `sh`, 이미지 `Do`·`BI`, 패턴 색 텍스트, Type3 글리프 경로(4.2 에서 대상에서 뺀다).

## 2. 결정 사항

| # | 주제 | 상태 |
| --- | --- | --- |
| D1 | 셀 편집 단위 | **결정 대기**(권고안) |
| D2 | 벡터 편집 범위(기하·다중 선택·삭제) | **결정 대기**(권고안) |
| D3 | 새 색의 색공간 | 권고 |
| D4 | 패스 쓰기 방식 | 권고 |
| D5 | 셀 초과 처리 | 권고(2026-10-20 사용자 결정의 셀 적용) |
| D6 | 편집 가능 표시 UI | 권고 |

### D1 셀 편집 단위

- 권고: **셀 하나 = 편집 단위**. layout-recon 이 한 셀을 여러 문단으로 나눠도(셀 안 줄 간격·짧은 줄) 셀 안 문단 전부를 한 대상으로 묶고, 문단 사이는 강제 줄바꿈으로 시작 텍스트를 만든다. 셀 안 문단 하나를 더블클릭해도 대상은 그 셀이다.
- 대안: 셀 안 문단 하나씩 편집(M3 문단과 같은 단위). 셀이 잘못 나뉘면 사용자가 문단을 따로 고쳐야 한다.
- 근거: M2 셀 줄 일치는 test 0.621·test2 0.931 로, 셀 안 문단 나누기가 불안정하다. 셀은 사용자가 보는 편집 단위다.
- 구현: 대상의 `glyphSeqs` = 셀 문단 글자 전부(읽기 순서), `ParagraphTarget.cell` 에 표·행·열. `planParagraphEdit(pageIndex, paragraphId)` 는 셀 문단 id 를 받으면 셀 대상으로 넓힌다(RPC 추가 없음).
- 셀 안 문단 잇기: 앞 줄이 셀 오른쪽 여백 근처(1em 안)까지 차고 줄 간격이 같으면 공백으로 잇고, 아니면 `\n`(문단 나누기 불안정을 강제 줄바꿈으로 굳히지 않기 위함).

### D2 벡터 편집 범위

- 권고:
  - 편집 단위 = 칠하기 연산 하나(`f`·`S`·`B` 등). `B` 계열(채움 + 선)은 PathInfo 2개지만 한 대상이다.
  - 기하: 패스 전체의 이동·크기 조절(상자 핸들, Shift 로 비율 고정)만. 점 단위 편집은 범위 밖.
  - 속성: 채움 색, 선 색, 선 두께.
  - 다중 선택: Shift+클릭으로 여러 패스를 골라 같은 속성·같은 이동을 한 번에 적용(한 편집 단위).
  - 삭제: 지원하지 않음(PLAN.md 1.3 에 없음).
- 결정이 필요한 것: 다중 선택 포함 여부, 패스 삭제 포함 여부.

### D3 새 색의 색공간

- 사용자가 고른 색(sRGB)을 원래 칠하기 색공간 계열(성분 수 1·3·4)의 Device 공간으로 쓴다(Gray·RGB·CMYK 단순 변환). 목표 공간이 고른 색을 표현하지 못하면(Gray 계열에 채도 > 0) DeviceRGB 로 쓰고 경고 `color-space-changed`. Separation·DeviceN·Indexed·Lab 도 DeviceRGB + 같은 경고.
- 고른 색이 원래 rgb 근사와 같으면(8비트 반올림) 그 채널은 쓰지 않는다(CMYK 왕복 오차로 인한 거짓 변경 방지).
- 바꾸지 않은 채널(예: 선 색만 바꿀 때 채움 색)은 원래 연산을 그대로 둔다(PageModel `PaintColor` 를 다시 쓰지 않음).

### D4 패스 쓰기 방식

- 기하: 패스 구성 연산(`m l c v y re h`)의 숫자 피연산자를 새 좌표로 다시 쓴다(아핀 변환을 콘텐츠 공간에서 적용). `re` 는 회전이 없는 변환이면 `re` 그대로, 아니면 `m l l l h` 로 바꾼다. `cm` 을 덧씌우지 않는 이유: 선 두께·대시가 같이 늘고, 비균일 크기 조절에서 선이 찌그러진다.
- 속성: 첫 구성 연산 바로 앞에 `q` + 새 색·선 두께 연산, 칠하기 연산 바로 뒤에 `Q` 를 넣는다. 패스 사이(구성 ~ 칠하기)에는 연산을 넣지 않는다(명세상 불가).
- 바꾼 바이트는 M3 와 같이 스트림마다 원본 바이트 기준 교체 목록 하나로 적용하고(`applyReplacements`), 공유 /Contents 는 사본, Form 안 패스는 M3 바이트 복제 경로(D2 of M3)로 이 사용 위치만 고친다.
- `q`/`Q`·색·`w` 연산은 paintSeq 를 바꾸지 않는다. 그러나 문단 편집(편집 블록 `q /Blk Do Q`)은 Form BBox 클립 1개를 더해 그 뒤 패스의 paintSeq 를 1씩 민다(실측). 그래서 `paintSeq` 는 적용 시점 모델 기준이고 순서 재적용에서만 유효하다. 대상 확인용 `PathTarget.fingerprints`(칠하기 연산 이름, 구성 연산 수, 쪽 공간 상자, 구성 연산 바이트 해시)를 두고 plan·begin·재적용에서 맞지 않으면 실패로 처리한다(다른 패스를 고치지 않는다).
- 고려한 대안: 순수 이동만이면 `q 1 0 0 1 dx dy cm … Q` 도 두께·대시를 바꾸지 않고 바이트가 작다. 크기 조절과 한 경로로 다루기 위해 피연산자 다시 쓰기로 통일하고, 순수 이동 최적화는 측정 뒤 선택한다.
- `re` 를 그대로 둘 조건: 콘텐츠 공간 변환 행렬의 b = c = 0. 숫자는 `edit-common.ts` 의 `fmt9`(지수 표기 없음)로 쓴다.

### D5 셀 초과 처리

- 2026-10-20 사용자 결정(자동 확장·되돌리기·경고 커밋)을 셀에 그대로 적용한다. 셀의 `areaLimit` = 셀 상자 − 여백(변마다 min(원 글자와 경계 간격, 2pt)) ∩ 쪽·클립·Form 상한이므로, 자동 확장은 셀 아래 경계에서 멈춘다.
- 셀 시작 `format.area`: 가로 = 셀 상자 − 여백(줄 폭이 셀 폭이 되게), 세로 = 글자 bbox. 정렬 = 셀 안 좌·우 간격 비교(차 < 1pt 면 가운데, 오른쪽 간격이 작으면 오른쪽). 정렬 전략 표는 열 정렬 키(x0·x1·cx)를 쓴다. M2 한 줄 문단 `align: 'unknown'` 을 셀에서는 쓰지 않는다.
- 정렬 전략 표(괘선 없음)는 셀 경계가 바깥 글자 외곽이므로 바깥 열·행을 이웃 간격 절반 또는 표 상자까지 넓힌 상자를 셀 상자로 쓴다. 넘치면 초과 표시·`overflow-clipped` 경고·"되돌리기", 경고 상태 커밋 허용.
- 행 높이는 바꾸지 않는다(행 추가·밀어내기는 범위 밖).

### D6 편집 가능 표시 UI

- 도구 막대 토글 "편집 가능 표시": 쪽 위에 문단(M3 색: 실선 = 가능, 점선 = 제한)·셀(같은 색, 셀 상자)·패스(가는 외곽선, 같은 색) 테두리를 모두 그린다. 범례 한 줄. 테두리에 마우스를 올리면 사유.
- 기본은 꺼짐. 켜도 텍스트 선택·편집 진입은 그대로다(포인터는 기존 층으로 통과).
- 패스는 작은 것(상자 짧은 변 < 1pt 이고 긴 변 < 4pt)은 그리지 않는다(괘선 조각·점 무리 방지). 개수가 2,000 을 넘으면 큰 순서로 2,000 개만.

## 3. 타입(packages/shared-types/src)

| 파일 | 추가·변경 |
| --- | --- |
| `edit.ts` | `ParagraphTarget.cell`(셀 대상), `PathTarget`(`fingerprints`)·`PathFingerprint`·`PathEdit`·`EditPathOp`, `EditOp = ReplaceParagraphOp \| EditPathOp`, `PATH_LIMIT_REASONS`·`PathLimit`, `PathEditability`, `PageEditability.paths`, `ParagraphEditability.cell`, `PathEditPlan`, `PathDraftUpdate`, 경고 `color-space-changed` |
| `rpc.ts` | `planPathEdit`·`beginPathEdit`·`updatePathDraft`·`commitPathEdit`·`cancelPathEdit` |
| `source-map.ts` | S1 이 채우는 선택 필드: `SourceOpState.strokeColorOps`·`lineWidthOps`, `SourceOp.pathOps`(칠하기·클립 연산의 구성 연산 id 목록), `SourceOp.operandRanges`(숫자·이름 피연산자 바이트 범위) |

- 패스 대상 식별: `PathTarget.paintSeqs` = 칠하기 연산별 첫 paintSeq(편집 적용 시점 PageModel 기준) + `fingerprints`(D4). `PATH_LIMIT_REASONS` 의 `singular-ctm` 은 문단 사유와 같은 이름·같은 뜻이다(서로소 아님).
- 셀·패스 초안도 문서당 하나(M3 5.7 과 같음). 패스 초안과 문단 초안은 동시에 열 수 없다.

## 4. 단계별 규칙

### 4.1 셀 편집(pdf-ops)

- 대상: `LayoutParagraph.table` 이 있는 문단. D1 에 따라 그 셀의 문단 전부. `not-flow-paragraph` 제한은 표 셀에는 붙이지 않는다(도형 라벨에는 계속).
- 그 밖의 판정·제거·삽입·폰트·쓰기는 M3 그대로. 시작 상태: 셀 문단 텍스트를 읽기 순서로 잇고 문단 사이 `\n`, 형식은 첫 문단(정렬·줄 간격·들여쓰기 0).
- `areaLimit`: D5. 원 영역 = 셀 문단 bbox 합집합.
- 커밋 뒤 레이아웃(검토 BLOCKER): 지금 reconstruct 는 `fixedGroups` 줄을 표 감지 입력에서 뺀다(`reconstruct.ts`). 그러면 셀이 비고, 정렬 전략 표는 감지가 깨질 수 있다. 바꿀 규칙: fixedGroups 줄도 표 감지 입력에 넣고, 감지 뒤 한 묶음의 줄이 모두 한 셀에 들면 그 셀의 문단 = 그 묶음 하나(`table` 설정). 여러 셀에 걸치면 지금처럼 고정 흐름 문단. 담당 S1(layout-recon `reconstruct.ts` 허용).
- 판정 목록: 셀은 한 항목(`ParagraphEditability.cell` 설정, 상자 = 셀 상자).

### 4.2 패스 판정(pdf-ops)

| 제한 사유(`PATH_LIMIT_REASONS`) | 조건 |
| --- | --- |
| `clip-path` | 대상 연산이 클립(`W`·`W*` 포함, Form BBox 클립) |
| `pattern-or-shading` | 채움·선 재료가 패턴·셰이딩, 또는 `sh` |
| `path-op-unparsed` | 구성 연산을 찾지 못하거나 피연산자가 숫자가 아님 |
| `path-spans-streams` | 구성 ~ 칠하기 연산이 /Contents 스트림 경계에 걸침 |
| `inside-text-object` | BT 안의 패스(비표준) |
| `path-interleaved-ops` | 첫 구성 연산 ~ 칠하기 사이에 `m l c v y re h W W*` 외 연산(`q Q cm gs w d J j M`, 색, `BMC/BDC/EMC` 등)이 있음(명세 8.2 위반이나 MuPDF 는 실행. 끼인 `w`·`Q` 가 새 속성을 무시하거나 상태를 샘, 실측) |
| `soft-mask` | 칠하기 시점 ExtGState 에 SMask 가 있음(옮기면 마스크는 그대로라 잘림) |
| 연산 `limits` | `unmatched`·`tokenizer-error`·`spans-stream-boundary`·`outside-page-content`(L4)·`form-depth-exceeded`(L5). `optional-content`(L7)는 경고, `tagged-content` 는 패스에서는 제한 아님 |
| `singular-ctm` | 칠하기 시점 CTM 특이 |

- 대상 아님(판정 목록·오버레이에서 뺌, 제한 표시 아님): 소유 연산이 `S s f F f* B B* b b*` 가 아닌 칠하기(Form `Do` BBox 클립, `sh`, 이미지, 패턴 색 텍스트, Type3 글리프 경로)와 `PathInfo.op` 가 `clip`·`clip-stroke` 인 항목.
- 경고: `optional-content`, `color-space-changed`(D3), `shared-form`(Form 복제로 이 위치만 바뀜, 정보), `path-clipped`(편집 후 상자가 칠하기 시점 clipRect·Form BBox 밖으로 나감, 초과와 같은 처리), `tagged-structure-unlinked`(태그 쪽 Form 복제로 `/StructParents` 를 지움, M3 D1 과 같음).
- PLAN.md 3.4 L1(Resources 상속)·L2(MCID)는 패스 편집에 리소스·구조 변경이 없으므로 제한으로 쓰지 않는다(정책 변경, 7절에 반영).
- 판정 시간: 쪽 패스 전부를 판정해도 쪽당 200 ms 이하(서버 Node, 코퍼스 최대 패스 쪽 기준, 측정 기록).

### 4.3 패스 쓰기(pdf-ops)

- D4. 기하 변환은 페이지 공간 아핀(이동·크기)을 받아 콘텐츠 공간으로 옮긴다(`ctm` 역행렬). 숫자는 유효숫자 9자리.
- 선 두께는 사용자가 페이지 공간 pt 로 정하고, 콘텐츠 공간으로 바꿔 `w` 로 쓴다(√|det(CTM)| 로 나눔, MuPDF `fz_matrix_expansion` 과 같음). 원래 `w = 0`(헤어라인)은 표시값 0, DoD "선 두께 ×2" 는 0 이면 0.5pt 로 둔다.
- 다중 선택: 대상마다 같은 변환·속성, 한 저널 작업. 같은 Form 사용 체인 안의 여러 패스는 복제본 하나에 교체 목록을 합친다(2중 복제 금지).

### 4.4 core

- `EditOp` 종류로 분기: 재적용·undo/redo 영향 쪽·메타 기록·`#unlinkedBlocks` 가 `op.kind` 를 본다. `LogEntry.summary` 는 문단 편집에만 있다.
- 패스 초안: `beginPathEdit` 에서 저널 작업을 열고, `updatePathDraft` 는 바꾼 스트림 바이트를 다시 쓰고(작업 안) 변경 영역(편집 전 ∪ 후 상자)을 렌더한다. 커밋·취소는 M3 와 같다.
- 재적용: 패스는 `paintSeq` + fingerprint 확인(D4), 맞지 않으면 실패 처리.
- 셀 대상(`target.cell`) 재적용: `glyphSeqs[0]` 을 담은 문단 → 그 셀로 넓힌 뒤 셀 glyphSeqs 전체 일치를 확인한다(지금 `findParagraphId` 는 한 문단 일치만 찾는다).
- `planPathEdit` 은 `revision` 을 돌려주고, `beginPathEdit` 은 그 `revision` 을 받아 낡은 모델의 paintSeq 를 거절한다(M3 문단과 같음).

### 4.5 viewer-ui

| 항목 | 규칙 |
| --- | --- |
| 셀 진입 | 셀 위 테두리(셀 상자), 더블클릭으로 셀 편집. 이후는 M3 편집기와 같다 |
| 패스 선택 | 편집 가능 표시를 켠 상태, 또는 Alt+클릭으로 패스 선택(글자 선택과 충돌 방지). 맞음 판정: 선은 화면 4px 안, 채움은 안쪽. 겹치면 가장 작은 패스 |
| 패스 편집 | 선택 상자 핸들로 이동·크기, 속성 패널(채움 색·선 색·선 두께). 끄는 동안은 원 렌더 래스터 조각을 변환해 미리보기, `updatePathDraft` 는 200 ms 정지 뒤와 놓을 때만. 놓으면 커밋, Esc 는 취소. 색 선택기의 연속 입력은 선택기를 닫을 때 한 번 커밋 |
| 다중 선택 | D2 결정에 따름 |
| 편집 가능 표시 | D6 |
| 표 격자 오버레이 | 병합 셀 기준으로 그림(W4-6) |
| 입력 버퍼 | 편집기가 열리는 동안 입력을 모아 열린 뒤 넣는다(M3 이관) |
| 복구 로그 | `EditPathOp` 도 M3 D6 과 같이 보관·`replayEdits` |

## 5. 검증 전제와 작업 분할

### 5.1 검증 전제

| # | 전제 | 담당 |
| --- | --- | --- |
| V1 | 칠하기 연산의 구성 연산은 실행 순서상 직전 칠하기(또는 `n`) 뒤부터 그 칠하기 앞까지의 구성 연산이다(같은 스트림). 스트림 경계를 넘으면 `path-spans-streams`, 사이에 다른 연산이 끼면 `path-interleaved-ops`. 코퍼스에서 끼인 연산 건수를 센다 | pdf-ops |
| V2 | `q` 를 첫 구성 연산 앞, `Q` 를 칠하기 연산 뒤에 넣어도 편집하지 않은 내용의 렌더가 같다(세 엔진 0 px). 클립이 없는 칠하기에 한함 | pdf-ops |
| V3 | 피연산자 숫자를 다시 써도 같은 좌표면 세 엔진 렌더가 같다(9자리) | pdf-ops |
| V4 | 셀 편집 블록이 커밋 뒤에도 같은 셀 안 문단으로 복원된다. 시험: 정렬 전략 3행 표·괘선 표에서 셀 1개 커밋 뒤 표 감지 유지, 그 셀 문단 = 블록 하나(`table` 설정) | S1(layout-recon)·S2 |
| V5 | 끌기를 놓은 뒤·정지 뒤 갱신(스트림 다시 쓰기 + 영역 렌더)이 반응 예산 안이다. 측정 쪽은 코퍼스 최대 패스 쪽으로 고정 | core |

### 5.2 작업 분할(M3 계약 6.2 공통 규칙과 같음)

| 작업 | 담당 모델 | 허용 파일 | 구현 |
| --- | --- | --- | --- |
| S1 pdf-ops | Opus 설계 + Sonnet 구현 | `packages/pdf-ops/**`(`font-assign.ts` 제외), `packages/layout-recon/src/reconstruct.ts`·그 시험, `docs/m4-pdf-ops.md` | 4.1 셀 판정·시작 상태·영역·정렬·areaLimit·레이아웃 규칙, 인터프리터 선택 필드(3절), 4.2 패스 판정, 4.3 패스 쓰기, R-L4, V1–V4. M3 26/110 진단에서 시작 상태(`edit-plan.ts`) 보정이 필요하면 S4 가 근거를 넘기고 S1 이 고친다 |
| S2 core | Sonnet, 설계 판단 Opus | `packages/core/**`, `docs/m4-core.md` | 4.4, EditOp 분기, 패스 RPC, 재적용, M3 이관(실패 상태 저장, 폴백 로드 실패), V4·V5 |
| S3 viewer-ui·extension | Sonnet | `packages/viewer-ui/**`, `apps/extension/**`(의존성 제외), `docs/m4-viewer-ui.md` | 4.5, 셀·패스 편집 UI, 편집 가능 표시, 표 격자(W4-6), 입력 버퍼, `renderScale` 전달(L1) |
| S4 M3 후속 | Opus | `packages/reflow/**`, `packages/pdf-ops/src/font-assign.ts`, `docs/m3-integration.md` 10절 | 같은 텍스트 bbox 초과 26/110 원인 진단·수정(reflow 쪽), R-L3(font-assign) |

- S2 는 R-M4·R-L5·R-L2(core 쪽)와 셀 재적용·패스 fingerprint 확인을 맡는다. pdf-ops 쪽이 필요하면 S1 에 요청한다.

## 6. 측정

### 6.1 코퍼스 편집 표본

- 표: financial-tables(ustreas-mts-202509, fed-h41-current, fed-combined-finstmt-2025, kogl-nabo-finstmt2025)와 kogl-mods-cpi-202609 의 표 쪽 2개씩, 표마다 셀 3개(머리 행 1, 숫자 셀 1, 글자 셀 1). 편집 3종: 같은 텍스트, 숫자 바꾸기(자릿수 +1), 한글 덧붙이기.
- 패스: vector-charts(arxiv-2609.09268, arxiv-2609.10511)와 kogl-mods-cpi-202609 도표 쪽 2개씩, 편집 가능 패스 5개(큰 것부터). 편집 3종: 채움 색, 선 두께 ×2, 10pt 이동.
- 지표: 1.1 의 시각·텍스트·객체, 편집 가능 비율·사유 분포(표 셀·패스 각각). 하네스는 M3 `edit-corpus-dod` 를 넓힌다.

### 6.2 성능

- 패스 끌기: 고정 패스 10개를 50 단계로 끌 때 단계마다 입력 → 영역 합성 시간.

## 7. PLAN.md 반영(D1·D2 확정 후)

- 1.3 표 편집 행: "초과 시 위와 같은 선택 UI" → 2026-10-20 결정 적용(D5), 셀 편집 단위(D1).
- 1.3 벡터 편집 행: D2 범위.
- 3.4: 패스 편집에는 L1·L2 를 제한으로 쓰지 않음(4.2).
- 6절 M4 행: 1.1 요약.

## 8. 계약 변경 절차

M3 계약 10절과 같다.
