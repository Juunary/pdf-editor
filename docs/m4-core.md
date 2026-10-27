# M4 core: 패스 편집 세션·EditOp 분기·셀 재적용·M3 후속

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-21 |
| 범위 | `docs/m4-contract.md` 작업 S2(core): 4.4, D2·D4(core 쪽), 1.2 R-M4·R-L5·R-L2, 5.1 V5 |
| 브랜치 | `m4-core` (기준: `m4` 브랜치 b3fdde8) |
| 환경 | 서버 Node 22.18, mupdf 1.28.1. 브라우저 미측정. pdf-ops 패스 함수(S1 구현 중)는 "M4 미구현"이라 가짜 어댑터로 검증 |
| 재현 | `pnpm --filter @pdf-editor/core test`(전체), `pnpm --filter @pdf-editor/core build` 후 `node packages/core/scripts/measure-m4.mjs max-paths｜drag ...`(스크립트 머리말 참고) |

## 1. 상태

| 항목 | 상태 |
| --- | --- |
| EditOp 종류 분기 | 구현. 로그 항목·초안이 문단/패스 유니온, 재적용·undo/redo·메타 기록·`#unlinkedBlocks`·`LogEntry.summary`(문단만)·`getPageEdits` 가 `op.kind` 를 본다 |
| 패스 RPC 5개 | 구현(가짜 어댑터 기준). `planPathEdit`·`beginPathEdit`·`updatePathDraft`·`commitPathEdit`·`cancelPathEdit` |
| 어댑터 | `planPathEditability`·`planPathEdit`·`preparePathEdit`·`writePathEdit` 추가. 기본 어댑터는 pdf-ops 스텁을 부른다 |
| `getPageEditability.paths` | 어댑터 결과로 채움. pdf-ops 가 "M4 미구현" 이면 빈 목록(6절 #5) |
| 재적용 | 패스: 지문 확인 후 적용, 셀: `glyphSeqs[0]` 문단 → 셀 → 셀 글리프 전체 일치 확인 |
| R-M4 | 구현. 실패 상태에서도 저널 감싸기 없이 저장, 경고를 `SavePlan`·`SaveResult` 의 core 확장 필드 `warnings` 로 알림 |
| R-L5 | 구현. 폴백 폰트 로드 실패는 폴백 없이 진행 |
| R-L2 | 구현(core 쪽). 저장 작업 안에서 서브셋 교체 뒤 `/BaseFont`·`FontName` 에 서브셋 태그 |
| V5 | 측정 스크립트 작성·대체 측정(proxy) 완료. 실제 패스 쓰기 측정은 S1 병합 뒤(4절) |
| 미완 | 실제 pdf-ops 연결 검증, V4(셀 커밋 뒤 셀 복원, S1 합류 필요), 코퍼스 8.1 표본(메인 세션) |

## 2. 설계

### 2.1 EditOp 분기

| 대상 | 문단(`replace-paragraph`) | 패스(`edit-path`) |
| --- | --- | --- |
| 로그 항목 | `ParagraphLogEntry`: `summary`·`usesFallback` 있음 | `PathLogEntry`: `op`·`warnings` 만 |
| 초안 | `ParagraphDraft` | `PathDraft`(`edit`·마지막 쓴 `bbox`·`redoBackup`) |
| 영향 쪽 | `pagesOf(op)` = `[target.pageIndex]` (undo·redo 캐시 무효화, 메타 `pages`, 저장 요약 `pages`) | 같음 |
| 저장 변경 종류 | 폴백 글리프를 쓰면 `font-embed` 추가 | `content-stream` 만 |
| `getPageEdits` | 편집 블록 목록·영역 | 포함하지 않음(블록 없음) |
| 구조 끊김 집계 | 같은 블록 연쇄의 마지막 항목만 | 항목마다 센다(Form 복제로 `/StructParents` 를 지우므로) |
| 재적용 | `findParagraphId`(흐름 문단 또는 셀) → 판정 → 준비 → 쓰기 | 지문 확인 → 판정 → 준비 → 쓰기 |

RPC 짝은 초안 종류로 강제한다: 패스 초안 id 로 문단 RPC 를, 문단 초안 id 로 패스 RPC 를 부르면 `EditStateError`. 패스 초안이 열려 있으면 문단 초안 시작·판정·undo/redo·저장도 M3 와 같이 거절한다.

### 2.2 패스 RPC

| RPC | 저널 | 동작 |
| --- | --- | --- |
| `planPathEdit` | 저널이 켜졌으면 버리는 작업(probe) | 어댑터 계획에 현재 `revision` 을 붙인다. 폴백 폰트를 불러오지 않는다 |
| `beginPathEdit` | 첫 편집 계열 호출이면 폴백 폰트 임베딩 후 저널 켜기(문단과 같음), `beginOperation('path-edit')` | revision 확인(낡으면 `StaleRevisionError`) → 계획 재계산(편집 불가면 거절) → `preparePathEdit`. 반환에 영역 렌더 없음(`BeginPathEditResult` 에 없음) |
| `updatePathDraft` | 같은 작업 안 | `writePathEdit` 로 다시 쓴 뒤 `(직전 쓴 상자 ∪ 새 상자) + 2pt` 를 `renderScale` 로 렌더. 첫 갱신의 직전 상자는 대상 상자. 경고 = 계획 경고 + 쓰기 경고(`warnings` 선택 필드) + core 근사 경고 |
| `commitPathEdit` | `recordEditMetadata` → `endOperation`, 저널 위치 확인 | 로그에 `EditPathOp` 추가, redo 비움, revision +1. 한 번도 쓰지 않은 초안은 거절 |
| `cancelPathEdit` | `abandonOperation` | 문서 원상태. redo 복원은 아래 |

- 쓰기는 원본 바이트 기준 절대 편집이다. 갱신마다 이전 쓰기와 무관하게 다시 쓰므로 반복 호출·끌기 중 마지막 값만 커밋된다. 이 의미는 계약 `writePathEdit`("같은 초안에서 반복 호출")의 해석이며 S1 확인이 필요하다(6절 #8).
- 쓰기 실패: 직전 편집(없으면 변경 없음 편집)을 다시 써 되돌리고 초안은 유지한다. 되돌리기도 실패하면 `broken` 으로 취소만 허용한다(문단 초안과 같음).
- redo: MuPDF 는 작업 안에서 객체를 처음 바꿀 때 redo 를 버린다(`docs/m3-core.md` 2.4). 패스 초안은 시작할 때 core 의 redo 를 백업하고 비운 뒤, 취소 시 `doc.canRedo()` 가 true 면(문서를 바꾸지 않았음) 백업을 되살리고 false 면 비운다. 문단 초안은 시작이 항상 문서를 바꾸므로 이 처리가 필요 없었다.
- core 가 정하는 경고(근사): `color-space-changed`(Gray 계열 패스에 채도 있는 색, Separation·DeviceN·Indexed·Lab, 원래 rgb 근사와 같은 채널은 제외), `table-rule-removed`(삭제한 패스가 짧은 변 3pt 이하이고 괘선 표 상자와 겹침). `path-clipped` 는 칠하기 시점 클립을 아는 pdf-ops 만 정할 수 있어 `writePathEdit` 의 `warnings` 로 받는다. 같은 종류는 하나로 합친다.

### 2.3 재적용

- 패스: `planPathEdit(ctx, op.target.paintSeqs)` → `fingerprintMismatch(로그 대상, 현재 대상)`. 비교 항목은 칠하기 연산 수·`paintOp`·`constructOpCount`·`constructHash`·상자(허용 오차 2e-3). 하나라도 다르면 `재적용 대상 패스가 다름` 으로 실패하고 세션은 문서를 다시 열어야 하는 상태가 된다(문단 재적용 실패와 같음). `paintSeq` 는 적용 시점 모델 기준이므로 로그 순서 재적용에서만 유효하다(편집 블록 `Do` 가 뒤 패스 paintSeq 를 민다, 계약 D4).
- 셀(`target.cell`): `glyphSeqs[0]` 을 가진 문단 → 그 문단이 든 표 셀 → 셀 문단 글리프 전체가 `glyphSeqs` 와 같은 집합이고 표 id·행·열이 로그의 `cell` 과 같을 때만 그 문단 id 를 쓴다(그 id 로 `planParagraphEdit` 를 부르면 pdf-ops 가 셀로 넓힌다, 계약 D1). 순서는 따지지 않는다. 셀 안 문단 순서는 pdf-ops 시작 상태 규칙이 정하고, 재적용은 로그의 `runs` 를 쓰므로 집합 일치로 충분하다.
- `cell` 이 없거나 null 이면 기존 규칙(글리프 목록이 같은 문단 하나).

## 3. M3 후속

### 3.1 R-M4 실패 상태 저장

- 원인: `#failure`(재적용 실패·저널 불일치·작업 버리기 실패)가 되면 `runSave` 의 `#assertUsable` 이 던져 미저장 편집을 내보낼 수 없었다.
- 처리: `runSave` 는 닫힌 문서만 거절하고, 실패 상태면 `requireNoDraft`·저널 감싸기 없이 `fn()` 을 바로 부른다(실패 상태는 undo 도 막혀 있어 저널에 저장 단계가 생겨도 해가 없다). `saveWarnings()` 가 사유를 포함한 경고 두 줄(엔진 오류 사유, 마지막 편집 누락·일부 반영·취소한 초안 변경 포함 가능)을 돌려주고 `PdfSession.planSave`·`save` 가 `warnings: string[]` 로 싣는다(정상이면 빈 배열).
- 실패 상태에서 열린 작업이 남아 있으면(작업 버리기 실패) 저장은 그 작업의 변경을 포함한다. 경고 문구가 이를 알린다.
- 실패 상태 저장도 폴백 서브셋 교체·서브셋 이름 태그(R-L2)를 최선 노력으로 한다(저널 없이 작업 문서에 남음, 오류 무시).
- `SavePlan.warnings?`·`SaveResult.warnings?` 는 shared-types 선택 필드다(리뷰 M2). 뷰어 `decideSave` 가 비어 있지 않으면 확인 창 맨 앞에 보인다.

### 3.2 R-L5 폴백 폰트 로드 실패

- 원인: `loadFallbackFont` 예외가 판정 RPC 까지 전파돼 편집 기능 전체가 꺼졌다.
- 처리: 로드 실패를 잡아 `fallbackLoadError` 에 기록하고 폴백 없이 진행한다. 실제 `FontManager` 는 `FallbackFontSource.bytes()` 가 예외를 내면 폴백 없음으로 다루므로(`font-assign.ts` `fallbackMetrics`) 원본 폰트에 없는 글자만 `glyph-missing` 이다. 실패는 캐시하지 않아 저널을 켜기 전의 다음 호출이 다시 시도하고, 늦게 성공하면 `FontManager` 를 새로 만든다(폴백 없음 판정을 캐시하므로). 저널이 켜진 뒤에는 폴백 폰트를 문서에 넣을 수 없어 다시 시도하지 않는다. 이 경우 그 세션에서는 한글 등 폴백 글자가 계속 `glyph-missing` 이다.
- 진단용 `PdfSession.fallbackLoadError`(shared-types 변경 없음).

### 3.3 R-L2 폴백 서브셋 이름 태그

- 원인: pdf-ops `FontState.finalizeForSave` 는 FontFile2·ToUnicode·`/W` 만 서브셋으로 바꾸고 `/BaseFont` 를 그대로 둬 저장 파일의 이름이 `NotoSansKR` 이다(서브셋은 `ABCDEF+` 접두 필요, PDF 32000 9.6.4).
- 처리(core 호출부, pdf-ops 변경 없음): 저장 작업 안에서 `finalizeForSave` 직후 `tagFallbackSubset` 이 Type0 `/BaseFont`, 하위 CIDFont `/BaseFont`, `FontDescriptor/FontName` 에 같은 태그를 붙인다. 태그는 서브셋 FontFile2 바이트의 FNV-1a 해시에서 만든 6자리 대문자라 같은 글자 집합이면 같다(결정성). 이미 태그가 있으면 건드리지 않는다. 작업을 버리므로 작업 문서의 폰트 이름은 그대로다.
- 폴백 글리프를 쓰지 않은 편집만 있으면 호출하지 않는다(저장 파일에 폴백 폰트가 없음).
- pdf-ops 가 `finalizeForSave` 에서 직접 태그를 붙이게 하면 core 호출을 지울 수 있다(6절 #10).

## 4. V5 측정

방식: 서버 Node 22.18, mupdf 1.28.1, DrawDevice RGB. 코퍼스 PDF 는 읽기만 했다. 스크립트 `packages/core/scripts/measure-m4.mjs`.

### 4.1 코퍼스 최대 패스 쪽(측정 쪽 고정)

`measure-m4.mjs max-paths`(칠하기 `fill`·`stroke` 패스 수, 24개 문서 전체 쪽, 29 s).

| 문서 | 쪽(1부터) | 패스 수 | 비고 |
| --- | --- | --- | --- |
| **kogl-mods-cpi-202609** | **4** | **32,135** | **코퍼스 최대. V5 측정 쪽으로 고정**(콘텐츠 3,800 KB, `docs/m3-core.md` 2.6 의 최대 스트림 쪽과 같음) |
| kogl-nabo-finstmt2025 | 153 | 9,006 | |
| kogl-nabo-rnd107 | 97 | 8,274 | |
| arxiv-2609.10511 | 7 | 3,394 | vector-charts 중 최대 |
| arxiv-2609.09268 | 10 | 2,055 | vector-charts |

### 4.2 끌기 갱신 시간

조건: 쪽의 큰 패스 10개를 단계마다 x 로 0.5pt 이동, 50 단계. 단계 시간 = 스트림 다시 쓰기 + `(직전 상자 ∪ 새 상자) + 2pt` 영역 렌더(`updatePathDraft` 에서 `invalidateAround` 포함).

**모드: proxy(대체 측정).** pdf-ops `writePathEdit` 가 "M4 미구현"이라 쪽 콘텐츠 스트림 전체를 같은 바이트로 다시 쓴 시간(패스 하나의 바이트 교체 쓰기 비용의 상한)과 실제 영역 렌더를 쟀다. 패스 구성 연산 재작성·지문 계산·Form 복제 비용은 들어 있지 않다.

| 쪽 | 배율 | 갱신 p50 | p95 | 최대 | 쓰기 p50 | 렌더 p50 |
| --- | --- | --- | --- | --- | --- | --- |
| kogl-mods-cpi 4쪽(32,135 패스) | 2 | 84.0 ms | 86.7 ms | 96.1 ms | 2.0 ms | 81.5 ms |
| 같은 쪽 | 1 | 80.8 ms | 88.0 ms | 90.2 ms | 2.8 ms | 78.1 ms |
| arxiv-2609.10511 7쪽 | 2 | 38.9 ms | 41.0 ms | 49.0 ms | | |
| arxiv-2609.09268 10쪽 | 2 | 35.4 ms | 37.3 ms | 48.1 ms | | |

- 렌더가 갱신의 대부분이다(최대 패스 쪽 약 97%). 콘텐츠 해석은 영역·배율과 무관하게 쪽 전체를 읽으므로 영역 크기·배율을 줄여도 시간이 줄지 않는다(배율 1 이 2 와 같음).
- 계약 1.1 의 "패스 끌기 p95 100 ms 이하"는 입력 → 합성 시간이고, 끄는 동안은 래스터 조각 변환 미리보기이며 `updatePathDraft` 는 놓을 때·정지 뒤에만 부른다(4.5). 그 호출 하나가 최대 패스 쪽에서 p95 87 ms 로, 실제 쓰기(S1) 비용을 더하면 예산 여유가 약 13 ms 밖에 없다. 실제 쓰기가 큰 스트림 전체를 한 번 읽고 교체 목록으로 다시 쓰는 비용(수 ms)을 넘으면 최대 패스 쪽은 예산을 넘을 수 있다.
- 개선 후보(미구현): 편집 대상을 뺀 나머지를 DisplayList 로 한 번 만들어 두고 영역만 다시 그리기(`docs/m3-core.md` 2.6 과 같은 후보). 통합 측정에서 최대 패스 쪽이 예산을 넘으면 검토한다.

### 4.3 커밋·갱신 뒤 다시 계산하는 비용(같은 쪽)

`updatePathDraft` 는 캐시를 비우기만 하고 다시 만들지 않아 위 시간에 들어 있지 않다. 다음 `getPageEditability`·`planPathEdit` 가 쪽 상태를 다시 만든다.

| 단계 | 시간(3회 범위) |
| --- | --- |
| 추출(`extractPage`) | 232–301 ms |
| SourceMap 빌드 | 446–535 ms |
| 연결(`linkPage`) | 65–78 ms |
| 레이아웃 | 387–588 ms |

- 합계 약 1.2 s. 계약 4.2 의 "쪽 패스 전부 판정 쪽당 200 ms 이하"는 이 쪽에서 SourceMap 빌드만으로 넘는다. 패스 판정 자체 비용은 S1 구현 뒤 별도로 잰다. 뷰어는 커밋 직후 편집 가능 표시를 새로 받을 때 이 지연을 고려해야 한다(S3).

## 5. 통합 때 할 일

1. S1 병합 뒤 `defaultEditAdapter` 로 `edit-path.test.ts`·`edit-m3-followup.test.ts` 의 흐름을 다시 돌린다(가짜 어댑터 의존: 한 줄 = 패스 하나 `x y w h re f`, 쓰기 결과 `warnings`). 어댑터 독립 단언(저널·로그·revision·redo·재적용 틀)은 그대로 유효해야 한다.
2. `EditEngine.#planPaths` 의 "M4 미구현" 삼킴을 제거한다(S1 병합 뒤 판정 오류는 숨기지 않는다).
3. `measure-m4.mjs drag` 를 실제 모드(`mode: real`)로 다시 돌려 4.2 를 갱신한다. 최대 패스 쪽에서 p95 100 ms 를 넘으면 DisplayList 캐시를 검토한다.
4. V4: 셀 하나 커밋 뒤 표 감지 유지·셀 문단 = 블록 하나(`table` 설정). core 쪽 연결(`fixedGroups` 힌트 전달)은 M3 9.6 그대로이고 판정은 S1 `reconstruct.ts` 에 있다. 실제 어댑터로 정렬 전략 3행 표·괘선 표를 만들어 `edit-real.test.ts` 에 더한다.
5. 코퍼스 하네스(`edit-corpus-dod`)에 셀·패스 표본을 넓힌다(메인 세션, 계약 6.1). 재적용 결정성(원래 결과 = 재적용 결과)을 셀·패스 포함으로 비교한다.
6. shared-types 변경 요청(메인 세션): `SavePlan.warnings?`·`SaveResult.warnings?`(R-M4 UI), `writePathEdit` 반환의 `warnings?: EditWarning[]`(6절 #1). 뷰어는 저장 계획 응답의 `warnings` 가 비어 있지 않으면 사용자에게 보인 뒤 저장한다.
7. 뷰어(S3): 패스 초안 시작은 쪽 /Contents 를 쓰지 않는다(Form 안 패스는 복제본·Resources 등록으로 시작 때 문서를 바꾼다). 초안 중에는 `getEditHistory().canRedo` 가 false 로 보인다. 갱신(`updatePathDraft`) 없이 취소하면 redo 가 되살아난다(쪽 /Contents 안 패스). 한 번이라도 갱신했거나 Form 복제가 일어났으면 MuPDF 가 redo 단계를 버려 취소해도 돌아오지 않는다(`edit-real-m4.test.ts` "redo 보존"). 문단 초안은 시작하면 redo 가 사라진다. 커밋 후 `affectedPages` 는 한 쪽이다.
8. Worker 연결: `worker-api.ts`·`worker.ts` 는 계약 커밋에 이미 패스 RPC 가 연결돼 있다(변경 없음). `updatePathDraft` 반환의 `region.rgba.buffer` 전송은 `worker-api.ts` 에 이미 있다.

## 6. 계약 불일치·해석 차이

| # | 항목 | 내용 | 처리·제안 |
| --- | --- | --- | --- |
| 1 | `writePathEdit` 반환 | 계약 시그니처 `{ bbox, writeMs }` 에는 쓰는 도중 정해지는 경고(`color-space-changed`·`path-clipped`)를 실을 곳이 없다 | core 가 어댑터 타입에 `PathWriteResult = 반환 & { warnings?: EditWarning[] }` 를 두었다(pdf-ops 시그니처 변경 없음, 지금 구현은 그대로 대입 가능). pdf-ops 가 채우면 합쳐진다. `warnings` 를 공식 시그니처로 올릴지는 메인 세션 결정 |
| 2 | R-M4 경고 전달 | `SavePlan`·`SaveResult` 에 경고 필드가 없다 | 해소(리뷰 M2): shared-types `SavePlan.warnings?`·`SaveResult.warnings?` 추가, 뷰어 확인 창 연결 |
| 3 | `table-rule-removed`·`color-space-changed` 산출 | 계약은 경고 이름만 정하고 산출 주체가 없다 | core 가 계획(`PaintColor`)·레이아웃으로 근사한다(2.2). pdf-ops 가 같은 종류를 주면 합쳐진다. 근사는 거짓 양성이 있을 수 있다(예: 3 ICC 성분 공간은 Device 근사) |
| 4 | 셀 재적용 | 계약 4.4 "셀 glyphSeqs 전체 일치" | 순서 무시 집합 일치 + 표 id·행·열 일치로 구현. 순서까지 요구하려면 S1 의 셀 문단 순서 규칙을 확인해야 한다 |
| 5 | `getPageEditability.paths` 스텁 | pdf-ops 스텁은 "M4 미구현"을 던진다 | 통합 때 스텁 삼킴 제거. 리뷰 M4 뒤로는 모든 패스 판정 오류를 `paths: []` + `PageEditability.pathError`(진단)로 격리하고 문단 판정은 돌려준다 |
| 6 | `planPathEdit` 의 폴백 폰트 | 문단 판정은 폴백 바이트를 먼저 불러온다 | 패스 계획은 폰트가 필요 없어 불러오지 않는다(마우스 오버마다 4 MB 로드 방지). `beginPathEdit` 은 첫 편집 계열 호출이면 문단과 같이 불러오고 임베딩한 뒤 저널을 켠다(패스가 먼저여도 이후 문단 편집이 폴백을 쓰려면 필요) |
| 7 | 변경 없는 커밋 | 계약에 없음 | 한 번도 `updatePathDraft` 를 부르지 않은 초안의 커밋은 거절한다(빈 `EditPathOp` 방지). 뷰어는 놓을 때 항상 갱신 후 커밋한다 |
| 8 | `writePathEdit` 반복 호출 의미 | "같은 초안에서 반복 호출할 수 있다" | 원본 바이트 기준 절대 편집(직전 쓰기와 무관)으로 해석. 실패 복구의 "변경 없음 편집(`transform` 등 모두 null, `delete` false)이 원 바이트로 돌아간다"도 같은 가정이다. S1 확인 필요 |
| 9 | 구조 끊김 집계 | 계약은 문단만 정의 | 패스 편집의 `tagged-structure-unlinked`(Form 복제로 `/StructParents` 를 지움)는 항목마다 센다 |
| 10 | R-L2 위치 | 계약은 core 호출부와 pdf-ops `font-embed.ts` 조율을 말한다 | pdf-ops 변경 없이 core 가 처리했다. `finalizeForSave` 가 `font-assign.ts`(S4 영역)에 있어 pdf-ops 쪽으로 옮기려면 S4 가 맡는다. 옮기면 `tagFallbackSubset` 호출을 지운다 |
| 11 | 패스 초안과 `redo` | 문단 초안 시작은 redo 를 비운다 | 패스 초안은 백업·복원(2.2). `BeginPathEditResult` 에 `canRedo` 가 없어 뷰어는 `getEditHistory` 로 확인한다 |
| 12 | 판정 시간 목표 | 계약 4.2 쪽당 200 ms | 최대 패스 쪽은 SourceMap 빌드만 450 ms 이상(4.3). 목표 기준이 SourceMap 빌드 제외인지 계약 확인 필요 |

## 7. 시험

| 파일 | 건수 | 내용 |
| --- | --- | --- |
| `test/edit-path.test.ts` | 23 | 판정(paths·미구현 삼킴·다른 오류·계획), 초안(커밋·undo/redo, 변경 영역 = 직전 ∪ 새, 절대 편집, 다중 선택, 삭제, 변경 없는 커밋, 낡은 revision), 상태 규칙(RPC 짝, 취소·redo 복원, 준비·쓰기 실패 복구, 되돌리기 실패), 경고(core 근사·쓰기 경고 병합), 재적용(문단+패스 혼합, 지문 불일치), 저장 요약·구조 끊김 집계, 입력 검증 |
| `test/edit-replay-target.test.ts` | 8 | `findParagraphId`(흐름·셀·순서 무시·일부/초과·셀 위치 불일치·cell null), `fingerprintMismatch` |
| `test/edit-m3-followup.test.ts` | 9 | R-L5(폴백 없이 진행·glyph-missing 필요 글자만·저널 뒤 재시도 없음·저널 전 성공), R-M4(실패 상태 저장+경고·정상 경고 없음·초안 중 거절 유지), R-L2(태그·결정성·폴백 미사용·패스만) |
| `test/edit-engine.test.ts` | 1 갱신 | 폴백 로드 실패 시험을 R-L5 동작으로 |

가짜 어댑터 기반 시험은 core 의 저널·로그·캐시·재적용 틀을 검증하고 pdf-ops 패스 쓰기의 정확성은 검증하지 않는다.

## 8. 검증(2026-10-21, 이 worktree `m4-core`)

| 명령 | 결과 |
| --- | --- |
| `pnpm exec turbo run build typecheck test --force` | 통과(24개 작업, 캐시 0) |
| 단위 | core 260 통과·4 skip(m4 기준 220 → +40), pdf-ops 390(3 skip) |
| `pnpm lint` | 통과 |
| `pnpm exec prettier --check .` | 통과 |
