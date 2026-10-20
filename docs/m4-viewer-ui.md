# M4 S3 viewer-ui·extension: 셀 진입 · 벡터 패스 편집 UI · 편집 가능 표시

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-21 |
| 범위 | `docs/m4-contract.md` 작업 S3(4.5, D1·D2·D6, 1.2 이관 중 입력 버퍼·R-L1·W4-6) |
| 브랜치 | `m4-viewer-ui`(기준: `m4` 계약 커밋 `caa4654`) |
| 상태 | **구현 완료. 가짜 편집 호스트·실제 확장 빌드로 검증했다. 실제 core 패스 RPC(S2)·pdf-ops(S1) 연동 검증은 통합 후** |
| 변경 범위 | 허용 파일만 변경(`packages/viewer-ui/**`, `apps/extension/**`, 이 문서). `shared-types`·`core`·`pdf-ops`·루트 설정·`pnpm-lock.yaml`·의존성 무변경 |

## 1. 구현 범위

| 기능(계약 4.5) | 상태 | 구현 위치 |
| --- | --- | --- |
| 셀 진입: 셀 상자 테두리(`#pe-edit-hover[data-cell="1"]`), 더블클릭 → 셀 편집(이후 M3 편집기), 제한 셀 팝오버 "이 셀은 편집할 수 없습니다" | 완료 | `components/EditEntry.tsx`, `edit-controller.ts`(`isCellParagraph`) |
| 패스 선택: 편집 가능 표시 켠 상태의 클릭 또는 Alt+클릭. 맞음 = 선 화면 4px(+선 두께 절반)·채움 안쪽(even-odd/non-zero), 겹치면 가장 작은 것, Shift+클릭 다중 선택(더하기·빼기) | 완료 | `path-geometry.ts`, `path-controller.ts`(`selectAt`), `components/PathLayer.tsx` |
| 패스 편집: 선택 상자 이동·8 핸들 크기(Shift = 비율 고정), 점 편집 모드(꼭짓점·제어점), 속성 패널(채움 색·선 색·선 두께), 삭제(Delete 키·버튼, 다중 선택 포함) | 완료 | `path-gesture.ts`, `path-controller.ts`, `components/PathLayer.tsx` |
| 끄는 동안: 원 렌더 래스터 조각을 변환한 미리보기, `updatePathDraft` 는 마지막 이동 뒤 200 ms 정지 때와 놓을 때만, 놓으면 커밋, Esc 취소, 색 선택기는 닫을 때(`change`) 한 번 커밋 | 완료 | `path-gesture.ts`(`PATH_DEBOUNCE_MS`), `PathLayer.tsx`(`PathPreview`) |
| 편집 가능 표시(D6): 도구 막대 토글 `#pe-mark-toggle`, 문단·셀·패스 테두리(작은 패스 생략, 2,000 개 상한), 범례, 사유 툴팁, 포인터 통과 | 완료 | `edit-marks.ts`, `components/EditableMarks.tsx` |
| 표 격자 오버레이를 병합 셀 기준으로(W4-6) | 완료 | `table-grid.ts`, `components/LayoutLayer.tsx` |
| 입력 버퍼(M3 이관): 편집기가 열리는 동안 친 글자를 모아 열린 뒤 캐럿 위치에 넣기 | 완료 | `input-buffer.ts`, `edit-controller.ts`(`setInputBuffer`·`begin`), `mount.tsx` |
| R-L1: `ResilientPdf.beginParagraphEdit` 가 `renderScale` 을 넘기고 뷰어가 `first.region` 을 첫 영역으로 쓴다 | 완료 | `apps/extension/src/viewer/recovery.ts`·`main.ts`, `edit-session.ts`, `edit-controller.ts` |
| 복구 로그: `EditPathOp` 보관·`replayEdits` | 완료(`EditLog` 가 `EditOp` 전체를 다룬다. 단위 시험 추가) | `edit-log.ts` |

## 2. 동작 규칙과 설계 근거

### 2.1 구조(M3 구조에 더한 부분)

| 계층 | 역할 | DOM |
| --- | --- | --- |
| `path-geometry.ts` | 패스 평탄화·맞음 판정·상자 핸들 변환·점 번호. 순수 함수 | 없음 |
| `PathGesture`(`path-gesture.ts`) | 편집 동작 하나 = 초안 1개: 최신 편집만 보관, 200 ms 정지 뒤·`flush()` 에 `updatePathDraft`, 커밋·취소, 갱신 중 복구 재시작 | 없음 |
| `PathController`(`path-controller.ts`) | 패스 모델(`extractPage` + `includePathSegments`) 로드, 선택·점 편집 모드, 동작 시작·커밋·취소, 삭제, 편집 뒤 재판정 | 없음 |
| `EditController` | `paths` 를 소유. 문단 세션·패스 동작 상호 배제, 입력 버퍼, 편집 가능 표시 토글 | 없음 |
| `PathLayer`·`EditableMarks`·`EditEntry`·`PageSurface` | 이벤트 → 호출, 상태 → 화면 | 있음 |

패스 RPC(`planPathEdit` 등 5개)는 `PathHostApi`(`viewer-host.ts`)로 따로 받는다. 호스트가 주지 않으면 `controller.edit.paths` 가 null 이고 문단 편집은 그대로다. RPC 가 "M4 미구현" 예외를 내면 `disabled.path` 만 켜고(`FeatureName` 에 `path` 추가) 선택을 풀며 진단 로그 `path-unavailable` 를 한 번 남긴다.

### 2.2 패스 선택·편집 흐름

- 선택만으로는 초안을 열지 않는다(초안은 문서당 1개라 선택이 문단 편집을 막지 않게). 선택하면 `planPathEdit` 만 호출해 편집 가능 여부·현재 색·두께를 받는다(편집 불가면 사유 목록을 패널에 보인다).
- 끌기·색·두께·삭제 **동작 하나가 초안 1개 = 편집 1개**다: `beginPathEdit`(plan 의 `revision`, 낡았으면 다시 판정해 한 번 더) → `updatePathDraft` → `commitPathEdit`. 편집 없이 놓으면 `cancelPathEdit`(편집 수 불변).
- 끌기는 3 CSS px 넘게 움직인 뒤에 시작한다(클릭과 구분). `updatePathDraft` 는 마지막 이동 뒤 200 ms 정지(`PATH_DEBOUNCE_MS`, 시간 주입 가능)와 놓을 때(`flush`)만 보낸다. 서버 영역(`PathDraftUpdate.region`)이 오면 문단 편집과 같은 경로(`regionPlacement`)로 쪽 캔버스에 합성한다.
- 커밋 뒤 `invalidatePages` 로 쪽을 다시 읽고(패스 모델·판정 캐시 폐기), 삭제가 아니면 선택(paintSeq)을 유지한 채 다시 판정한다. 삭제는 선택을 푼다. 문서 undo/redo·쪽 이동·Worker 복구는 선택을 푼다.
- Esc: 끄는 중이면 동작 취소 → 점 편집 모드 종료 → 선택 해제 순서. Delete/Backspace 는 입력창에 포커스가 없을 때 삭제.
- 점 편집: 한 패스만(다중 선택이면 버튼 비활성). 점 하나를 끌 때마다 한 편집이다(`PathEdit.points` 1개, `transform` null). 점 번호는 `PageModel.PathInfo.segments` 를 앞에서부터 센 번호(M·L 1개, C 3개)를 **0 기준**으로 쓴다(5절 #1).

### 2.3 편집 가능 표시(D6)

- 켜면 쪽 위에 캔버스 하나(`#pe-marks-canvas`)에 문단(굵은 실선/점선)·셀(같은 색, 셀 상자)·패스(가는 선)를 그린다. 편집 가능 = 초록 실선, 제한 = 주황 점선(M3 문단 테두리와 같은 색). 범례 `#pe-marks-legend`는 화면 아래에 고정하고 생략한 패스 수를 보인다.
- 작은 패스(짧은 변 < 1pt 이고 긴 변 < 4pt)는 뺀다. 개수가 2,000 을 넘으면 면적이 큰 순서로 2,000 개만 남긴다(`MAX_PATH_MARKS`).
- 툴팁은 쪽의 `mousemove` 를 들어서(포인터 통과) 마우스 아래 가장 작은 표시를 찾아 `표 셀 · 제한: 사유` 형식으로 보인다.
- 켠 상태에서도 글자 선택·더블클릭 편집은 그대로다. 켠 상태의 단순 클릭은 패스 선택을 겸한다(글자를 끌어 선택한 직후의 click 은 패스 선택으로 보지 않는다).
- 편집 중(문단 세션)에는 표시를 숨긴다(옛 위치 방지, M3 규칙과 같음).

### 2.4 입력 버퍼

더블클릭 직후 숨은 `textarea`(`#pe-input-buffer`)에 포커스를 두어 `plan → begin` 왕복 동안 치는 글자(IME 조합 포함)를 받는다. 편집기가 열리면 `blur()` 로 진행 중인 조합을 확정(V7 실측과 같은 방식)한 뒤 NFC·U+00A0→U+0020·CRLF→LF 정규화(`normalizeInput`)해서 캐럿 위치에 한 번 넣는다. 편집을 열지 못하면(제한·오류) 버린다. 버퍼 안의 방향키·Backspace 는 `textarea` 기본 동작(버퍼 안에서만)이다.

### 2.5 R-L1

`EditController.begin` 이 뷰어 렌더 배율(`scale × devicePixelRatio`)을 `beginParagraphEdit` 4번째 인자로 넘기고, `ResilientPdf`·확장 호스트(`main.ts`)가 그대로 전달한다. `EditSession` 은 `begin.first.region` 을 첫 영역(seq 0)으로 쓰고 M3 의 "시작 직후 `updateParagraphDraft` 1회" 를 없앴다(seq 0 은 반응 시간 표본에 넣지 않는다).

### 2.6 표 격자(W4-6)

`LayoutLayer` 가 행·열 경계 전체 선 대신 셀(병합이면 병합 범위)마다 상자를 그린다. 셀 상자는 `rowBounds`·`colBounds` 와 `rowSpan`·`colSpan` 으로 만들고(`TableCell.bbox` 는 쓰지 않음, 5절 #8), 셀 목록에 없는 칸은 1×1 로 채운다(`gridCells`). 캔버스에 `data-grid-cells` 를 둔다.

## 3. 시험

| 종류 | 파일 | 건수 | 내용 |
| --- | --- | --- | --- |
| 단위 | `packages/viewer-ui/test/path-geometry.test.ts` | 12 | 후보 묶기, 맞음 판정(채움·선·even-odd·CTM·겹침), 핸들 변환(Shift 비율), 점 번호 |
| 단위 | `path-controller.test.ts` | 22 | 선택(Shift·4px·배율), 200 ms 정지 갱신, Esc 취소, 속성 한 번 커밋, 다중 선택 이동·삭제, 점 편집, revision 재시도, 갱신 중 복구, 갱신 실패 시 커밋 안 함, 기능 격리 |
| 단위 | `edit-marks.test.ts`·`table-grid.test.ts`·`path-colors.test.ts` | 4·2·2 | 표시 계산(작은 패스·2,000 상한), 병합 격자, 색 변환 |
| 단위 | `edit-controller.test.ts`(추가)·`edit-session.test.ts`(R-L1)·`edit-log.test.ts`(`EditPathOp`) | 3·1·1 | 입력 버퍼, 첫 영역, 로그 보관 |
| 단위 | `apps/extension/test/recovery.test.ts`(추가) | 1 | `renderScale` 전달 |
| e2e | `apps/extension/e2e/path-ui.spec.ts` | 21 | 셀 진입·제한 팝오버, R-L1·입력 버퍼, 편집 가능 표시(토글·범례·툴팁·포인터 통과), 패스 선택(Alt·Shift·4px·제한), 끌기 미리보기·정지 갱신·커밋, Esc 취소, Shift 비율 핸들, 색 선택기 1회 커밋, 선 두께, 점 편집, 다중 선택 이동·Delete, 삭제 버튼 + undo, 병합 격자 |

가짜 호스트(`test/fake-edit-host.ts`)에 패스 RPC·셀·패스 판정을 더했다(편집을 반영해 `pathInfos()` 로 돌려주므로 하니스 `extractPage` 가 편집 뒤 모델을 본다). 하니스 `edit-harness.ts` 는 `paths`·`layout2` 설정을 받는다.

## 4. 통합 때 켤 e2e 목록

`apps/extension/e2e/path-integration.spec.ts` 의 `test.describe` 첫 줄 `test.skip(true, INTEGRATION_SKIP)` 한 줄을 지우면 5건이 켜진다(그룹 전체를 건너뛰므로 확장을 띄우지도 않는다. 본문은 가짜 호스트 시험과 같은 DOM 식별자·`window.__pe` 이음매를 쓰며 통합 전에는 실행한 적이 없다). 문서는 시험이 만드는 1쪽 PDF(채움 사각형 + 선 + 글자 한 줄)다.

| # | 시험 | 켜는 조건 | 기대값·근거 | 조정 가능성 |
| --- | --- | --- | --- | --- |
| 1 | DoD: 채움 색 변경 → 저장 → 재열기 | S1·S2·S3 머지 | 색 `[0,1,0]`, 패스 수·선 패스 불변(계약 1.1 객체·벡터 축) | 사각형 클릭 좌표 |
| 2 | 이동 끌기 → 저장 → 재열기 | 위 | 상자 x 가 이동, 폭 불변(D4 기하) | 허용 오차 |
| 3 | 선 두께·삭제 → 저장 → 재열기 | 위 | 두께 6pt, 채움 패스 사라짐(D2 삭제) | 두께 값 |
| 4 | 패스 끌기 반응(V5) | 위 + V5 | 갱신 → 합성 p95 ≤ 100 ms(잠정, 계약 1.1 성능) | **측정 후 기준 조정**. 계약 6.2 모집단(고정 패스 10개 × 50단계)은 이 시험이 아니라 별도 하니스(메인 세션) |
| 5 | Worker 치명 오류 → 복구 → `EditPathOp` `replayEdits` 결과 = 복구 전 화면 | 위 + 재적용 결정성(fingerprint) | 복구 알림, 화면(`toDataURL`) 동일 | 화면 비교 대신 재추출 비교로 완화 가능 |

추가로 통합 때 확인할 것(시험 없음):

- `getPageEditability` 가 `paths`(`PathEditability`)와 셀(`ParagraphEditability.cell`)을 실제로 채우는지: 가짜 호스트 e2e 는 채워 주는 전제다.
- `planParagraphEdit` 가 셀 문단 id 를 셀 대상으로 넓히는지(D1). 뷰어는 셀 문단 id 를 그대로 보낸다.
- M3 `extension-save.spec.ts` 의 "M3 미구현" 건처럼, core 가 패스 RPC 를 구현하기 전까지 `disabled.path` 안내(`#pe-notice` "벡터 편집")가 뜨는지.

## 5. 계약 불일치·확인 요청(메인 세션)

| # | 내용 | 뷰어 처리 | 제안 |
| --- | --- | --- | --- |
| 1 | `PathEdit.points[].index` 의 시작 번호(0/1)가 계약에 없다. `shared-types/src/edit.ts` 주석은 "segments 를 앞에서부터 센 점(M·L 1개, C 3개)" 만 말한다 | **0 기준**(`pathPoints` 단위 시험으로 고정). 제어점·끝점 3개는 C 의 p1·p2·p3 순서 | 계약에 0 기준을 명시하거나 바꿔야 하면 알려 주십시오(`path-geometry.ts` 한 곳) |
| 2 | `PathEditPlan.lineWidth` 의 단위(경로 공간 vs 페이지 pt)가 없다. `PathEdit.lineWidth` 는 페이지 pt | 패널의 두께 입력을 페이지 pt 로 보고 plan 값을 그대로 표시 | plan 도 페이지 pt 로 명시(또는 CTM 환산 값을 돌려줌) |
| 3 | 맞음 판정·점 편집에 PathInfo 의 `segments` 가 필요한데 계약 4.5 는 데이터 원천을 말하지 않는다 | 패스 선택이 필요할 때(표시 켬/첫 Alt+클릭) 그 쪽 `extractPage({ includePathSegments: true })` 를 한 번 더 호출한다(쪽당 1회 캐시, 편집 뒤 폐기). 큰 도표 쪽에서 비용은 미측정 | `getPageEditability.paths` 에 경로 요약을 싣거나 현행 유지 결정 |
| 4 | `B` 계열(채움 + 선)은 PathInfo 2개지만 한 대상이라는 D2 문장에서 두 PathInfo 의 `paintSeq` 가 같다고 가정 | 같은 `paintSeq` 의 PathInfo 를 한 후보로 묶는다(`buildCandidates`) | 확인 |
| 5 | 끄는 동안 "원 렌더 래스터 조각 변환" 미리보기는 원래 위치를 지울 수 없다(배경 불명) | 200 ms 정지 전까지 원래 위치에 원본 픽셀이 남은 채 변환된 조각이 겹쳐 보인다. 서버 영역이 오면 정확한 렌더로 바뀐다. 점 편집은 래스터 변환이 불가능해 미리보기 없이 점 위치만 따라간다 | 허용 여부 확인(잔상이 문제면 정지 시간 단축 또는 원 영역 흐림 처리) |
| 6 | 편집 뒤 같은 패스를 계속 편집하려면 `paintSeq` 가 유지돼야 한다(삭제 제외). D4 는 q/Q/색/`w` 가 paintSeq 를 바꾸지 않는다고 하나 문단 편집 블록 삽입은 +1 이동 | 패스 편집 뒤에는 쪽을 다시 읽어 같은 `paintSeq` 로 재판정한다. 다른 편집으로 밀린 경우 fingerprint 불일치로 plan 이 실패할 수 있다(오류 알림) | 패스 편집 뒤 `PathEditability.paintSeq` 가 유지됨을 확인 |
| 7 | 셀 `ParagraphEditability.bbox` = 셀 상자라는 4.1 문장에 기댄다. 정렬 전략 표는 확장된 상자(D5) | 그대로 테두리·hit 상자로 쓴다 | 확인 |
| 8 | `TableCell.bbox` 가 셀 상자인지 글자 외곽인지 불명 | 격자는 `rowBounds`·`colBounds`·span 으로 계산(W4-6) | 명시 |
| 9 | 복구 중 진행하던 패스 동작의 취급이 계약에 없다 | 갱신 호출 중에 복구되면 같은 대상으로 `plan → begin → 최신 편집 재전송` 으로 이어 간다. 그 밖(커밋 호출·대기 중)은 동작을 취소하고 알린다("진행 중이던 패스 편집은 취소했습니다") | 확인 |

## 6. 남은 제한

| # | 제한·확인 | 비고 |
| --- | --- | --- |
| 1 | 실제 core 패스 RPC·pdf-ops 쓰기로 검증하지 않았다(가짜 호스트의 단순 변환: ctm 항등 패스만) | 통합 e2e(4절) |
| 2 | 회전한 쪽(`/Rotate`)·원점이 0 이 아닌 쪽에서 패스 선택·핸들 좌표는 `cssToPage` 변환에 의존, 단위 시험만 있다(M3 와 같음) | |
| 3 | 점 편집은 점 추가·삭제·선분 종류 변경 없음(D2). `re` 가 `m l l l h` 로 바뀐 뒤에는 점 번호 체계가 달라지므로 쪽을 다시 읽은 모델의 번호를 쓴다 | |
| 4 | 키보드 접근성(패스 선택·이동을 키보드로)은 다루지 않았다 | |
| 5 | MS 한글 IME 로 입력 버퍼를 통과하는 조합(실제 `keyCode 229` 경로)은 Windows 확인 필요(M3 8절 #2 와 같음). CDP 시험은 편집기 쪽만 있다 | |
| 6 | 표시를 켠 상태에서 글자를 단순 클릭하면 아래 패스가 있을 때 선택된다(글자 드래그 직후는 제외). 패스 위 글자 클릭이 잦으면 Alt 전용으로 바꿀 수 있다 | |

## 7. 검증 결과

2026-10-21, 이 worktree(서버 Linux, Playwright 번들 Chromium).

| 항목 | 결과 |
| --- | --- |
| `pnpm exec turbo run build typecheck test test:e2e --force` | **통과**(25개 작업 모두 성공, 종료 코드 0, 캐시 0) |
| 단위 시험 | viewer-ui 21 파일 **280건**, extension 5 파일 **44건** (M4 신규·추가 분은 3절) |
| e2e | **114건 통과, 7건 skip**(통합용 `path-integration.spec.ts` 5건 + 기존 동적 skip 2건). 신규 `path-ui.spec.ts` 21건 통과 |
| `pnpm lint` | 통과 |
| `pnpm exec prettier --check .` | 통과 |

## 8. Action Item

| # | 내용 | 담당 |
| --- | --- | --- |
| 1 | 5절 #1·#2·#3·#5·#6 결정 | 메인 세션 |
| 2 | S1·S2 머지 뒤 4절 e2e 5건 활성화·측정, 반응 시간 기준 고정은 사용자 확인 | 메인 세션 |
| 3 | 계약 6.2 패스 끌기 성능 하니스(고정 패스 10개 × 50단계) 작성 | 메인 세션 |
| 4 | Windows Chrome: 입력 버퍼 통과 IME 조합 | 사용자 |

## 9. 변경 파일

- `packages/viewer-ui/src/`: `path-geometry.ts`·`path-gesture.ts`·`path-controller.ts`·`path-colors.ts`·`edit-marks.ts`·`table-grid.ts`·`input-buffer.ts`(새), `components/PathLayer.tsx`·`components/EditableMarks.tsx`(새), `controller.ts`·`edit-controller.ts`·`edit-session.ts`·`edit-labels.ts`·`viewer-host.ts`·`mount.tsx`·`index.ts`·`style.css`·`components/Controls.tsx`·`components/EditEntry.tsx`·`components/PageSurface.tsx`·`components/LayoutLayer.tsx`(수정)
- `packages/viewer-ui/test/`: `path-geometry`·`path-controller`·`edit-marks`·`table-grid`·`path-colors` 시험, `path-fixtures.ts`(새), `fake-edit-host.ts`·`edit-controller.test.ts`·`edit-session.test.ts`·`edit-log.test.ts`(수정)
- `apps/extension/src/viewer/`: `recovery.ts`·`main.ts`(수정)
- `apps/extension/test/recovery.test.ts`(수정)
- `apps/extension/e2e/`: `path-ui.spec.ts`·`path-integration.spec.ts`(새), `edit-harness.ts`(수정)
