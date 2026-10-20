# M3 S4 viewer-ui·extension: 문단 편집기 · 저장 · 복구 · 확장 배포

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-19 |
| 범위 | `docs/m3-contract.md` 작업 S4: 5.9 뷰어 편집기, D7 미리보기, 5.8 저장, D6 복구, 열기 시 보고(A2-2·A5-3), 확장 배포, V7 |
| 브랜치 | `m3-viewer-ui`(기준: `m3` 계약 커밋 `a7464f1`) |
| 상태 | **구현 완료. 가짜 편집 호스트·실제 확장으로 검증했다. 실제 core 편집 RPC(S3)·pdf-ops(S1)·reflow(S2) 연동 검증은 통합 후** |
| 변경 범위 | 허용 파일만 변경(`packages/viewer-ui/**`, `apps/extension/**`, 이 문서). `shared-types`·`core`·`pdf-ops`·`reflow`·루트 설정·`pnpm-lock.yaml`·manifest 무변경. 새 의존성 없음 |
| 실측 환경 | 서버 Linux, Node 22.18.0, Playwright 1.64.1 번들 Chromium 156.0.8078.4(headless), 2026-10-19 |
| 계약 수정 반영 | `m3` 의 수정 1(`2cc9982`)·수정 2(`64f6fcd`)를 머지했다(2026-10-19). 수정 1 은 뷰어 영향 없음. 수정 2: 입력·붙여넣기·조합 확정에서 U+00A0 → U+0020, 폴백 폰트 파일 교체(dist 복사 대상 이름 동일) |

## 1. 구현 범위

| 기능(계약) | 상태 | 구현 위치 |
| --- | --- | --- |
| 진입: `getPageEditability` 문단 테두리(편집 가능 = 실선, 제한 = 점선·다른 색), 더블클릭 시작, 제한 사유 팝오버(5.9) | 완료 | `components/EditEntry.tsx`, `edit-controller.ts`, `edit-labels.ts` |
| 입력: 숨은 textarea, `beforeinput`·`composition*`, NFC + U+00A0 → U+0020(계약 수정 2), 텍스트만 붙여넣기, 줄바꿈 = 강제 줄바꿈 | 완료 | `components/EditorLayer.tsx`, `edit-text.ts`, `edit-model.ts` |
| 편집 모델: 텍스트·모양 구간·캐럿·선택·조합 구간, `charIndexOfOffset` 로 클릭 → 캐럿 | 완료 | `edit-model.ts`, `edit-geometry.ts`(`offsetAtPagePoint`) |
| 키: 화살표(줄 이동은 리플로우 줄 기준)·Home/End·Shift 선택·Ctrl+A·Backspace/Delete·Enter·Ctrl 단어 이동·삭제 | 완료 | `edit-keys.ts`, `edit-session.ts`, `edit-geometry.ts` |
| 편집 중 글자 단위 undo/redo(I6 단위) | 완료 | `edit-model.ts`(`TextHistory`) |
| 종료: 바깥 클릭·Esc(조합 아닐 때) = 커밋(변경 없으면 취소), 도구 막대 "편집 취소" | 완료 | `edit-session.ts`, `edit-controller.ts`, `components/Controls.tsx` |
| 초과 처리(2026-10-20 사용자 결정으로 변경, 2.9절): 영역 아래 변 자동 확장(리플로우), 영역 상한에 막힌 초과만 초과 표시선 + "되돌리기" | 완료 | `components/EditorLayer.tsx` |
| 영역 핸들(네 변·네 모서리, `areaLimit` 안, 최소 20×8 pt), 겹침 경고 상자 | 완료 | `edit-geometry.ts`(`resizeArea`), `components/EditorLayer.tsx` |
| 표시: 폴백 글자 점선 밑줄(토글), 없는 글자 표시, 경고 목록(중복 제거), 태그 쪽 안내, 태그 PDF 편집 막기 설정(기본 끔, D1) | 완료 | `components/EditorLayer.tsx`, `components/Controls.tsx`, `edit-controller.ts` |
| 편집 밖 문서 undo/redo(Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, 버튼) | 완료 | `components/Controls.tsx`, `edit-controller.ts` |
| D7 미리보기: `updateParagraphDraft` 결과 영역(`region`, clip)을 쪽 캔버스에 합성, 캐럿·선택·조합 밑줄·초과 표시는 `ReflowSummary` 로 그림, 처리 중이면 마지막 입력만 전송 | 완료 | `components/PageSurface.tsx`, `edit-paint.ts`, `edit-session.ts` |
| 저장(5.8): 초안 먼저 커밋 → `planSave` → `over-limit` 중단 안내, `warn`·구조 연결 끊김·PDF/A 확인 창 | 완료 | `apps/extension/src/viewer/main.ts`, `save-plan.ts`, `dialog.ts` |
| 복구(D6): 원본 `Blob` 보관, 커밋 `EditOp`·`activeEditIds` 보관, 새 Worker → 원본 열기 → `replayEdits`, 초안 중이면 편집기 모델로 초안 재시작, 저장 중 복구 시 다시 저장 질문 | 완료 | `apps/extension/src/viewer/recovery.ts`, `main.ts`, `edit-log.ts`, `edit-session.ts`(`restart`) |
| 열기 시 Redact 주석 보고(A2-2) | **알림은 완료, 데이터 원천 없음**(6절 #2) | `notices.ts`, `main.ts`(`reportRedactAnnots`) |
| DNR 경로 file:// 접근 꺼짐 안내(A5-3) | 완료(순수 판정 단위 시험, 실제 128–149 환경은 미확인) | `notices.ts`, `main.ts`(`reportFileAccess`) |
| 확장 배포: 폴백 폰트 dist 복사, Worker `loadFallbackFont`, harfbuzz wasm 번들, `verify-dist.mjs` | 완료(harfbuzz 는 reflow 연결 전이라 번들 동작만 실험 확인, 4.2절) | `src/worker/pdf-worker.ts`, `scripts/verify-dist.mjs` |
| "M3 미구현" 예외 시 편집 기능만 끔(`failure.ts` 규칙) | 완료 | `controller.ts`, `edit-controller.ts` |

## 2. 동작 규칙과 설계 근거

### 2.1 구조

| 계층 | 역할 | DOM |
| --- | --- | --- |
| `EditorModel`(`edit-model.ts`) | 불변 상태(텍스트·모양 구간·캐럿·선택·조합)와 되돌리기 이력. 순수 함수 | 없음 |
| `edit-geometry.ts` | `ReflowSummary` → 캐럿 상자·선택 상자·조합 밑줄·폴백 구간·없는 글자·줄 이동·클릭 → 캐럿. 순수 함수 | 없음 |
| `EditSession`(`edit-session.ts`) | 초안 1개: 입력 전송(마지막 입력만), 표시 프레임, 커밋·취소, 복구 재시작 | 없음 |
| `EditController`(`edit-controller.ts`) | 쪽 판정·진입(plan → begin)·종료·문서 undo/redo·복구 로그 | 없음 |
| `EditEntry`·`EditorLayer`·`Controls`·`PageSurface` | 이벤트 → 세션 호출, 상태 → 화면 | 있음 |

DOM 비의존 계층은 가짜 호스트(`test/fake-edit-host.ts`)로 Node 단위 시험을 한다. 같은 가짜 호스트를 e2e 하니스가 TypeScript `transpileModule` 로 JS 로 바꿔 페이지에 싣는다.

### 2.2 프레임 일관성과 "마지막 입력만 전송"

- 입력은 모델에 즉시 반영한다. Worker 로는 처리 중인 요청이 없을 때만 보내고, 처리 중이면 마지막 입력 하나만 남긴다(중간 입력은 합친다).
- 캐럿·선택·밑줄은 모델이 아니라 **마지막으로 처리된 프레임**(`EditSessionView.shown`: 입력 시점 텍스트·캐럿 + 그 결과 `ReflowSummary`)으로 그린다. 캔버스에 합성된 글자와 캐럿이 어긋나지 않게 하기 위해서다.
- 줄 기하가 필요한 동작(↑/↓·Home/End·마우스)은 앞선 입력이 처리된 뒤 실행한다(`EditSession.run`). 글자 입력은 기다리지 않는다.
- 반응 시간 계측: 가장 오래된 미처리 입력의 시각 → 영역 합성 직후까지를 `performance.measure('pe-edit-latency')` 로 남긴다(계약 8.4 구간).
- **시작 갱신**: `beginParagraphEdit` 에는 렌더 배율 인자가 없어 `BeginEditResult.first.region` 이 뷰어 배율과 같다는 보장이 없다(6절 #1). 뷰어는 `first.region` 을 합성하지 않고, 시작 직후 `updateParagraphDraft` 를 한 번 보내 뷰어 배율의 영역을 받는다. 이 갱신은 텍스트·형식이 시작 상태와 같으므로 "변경 없음"(커밋 = 취소)으로 센다.

### 2.3 입력 경로(숨은 textarea)

| 이벤트 | 처리 |
| --- | --- |
| `keydown` | `mapEditKey` 로 이동·삭제·Enter·Ctrl+A·Ctrl+Z·Ctrl+Shift+Z·Ctrl+Y·Esc 를 편집 동작으로 바꾸고 기본 동작을 막는다. Ctrl+S·Ctrl+F·Ctrl+C 등은 가로채지 않는다(저장·찾기·복사는 상위가 처리). 조합 중(`isComposing`·keyCode 229)이면 아무 동작도 하지 않고, Ctrl/Meta 조합은 기본 동작만 막는다(I5) |
| `beforeinput` | 조합이 아니면 `insertText`·줄바꿈·삭제 종류를 모델로 처리하고 기본 동작을 막는다. `historyUndo`·`historyRedo` 는 조합 여부와 무관하게 막는다 |
| `compositionstart/update/end` | 조합 구간을 모델 텍스트 안에서 교체하고 캐럿을 조합 끝에 둔다. 확정(`compositionend.data`)은 NFC 로 정규화한다 |
| `copy`·`cut`·`paste` | 편집기 선택 텍스트를 쓴다. 붙여넣기는 `text/plain` 만, CRLF → 강제 줄바꿈, NFC, U+00A0 → U+0020 |

textarea 는 캐럿 위치에 두어(투명, `opacity: 0.01`) IME 후보창이 캐럿 옆에 뜨게 한다. 이벤트는 Preact 의 이름 규칙(`oncompositionstart` 는 DOM 속성이 아님)과 무관하게 `addEventListener` 로 등록한다. 등록은 렌더 직후(레이아웃 효과)에 한다.

### 2.4 IME 시나리오 대응(계약 1.3)

| # | 구현 | e2e(`edit-ui.spec.ts`, CDP `Input.imeSetComposition`·`Input.insertText`) |
| --- | --- | --- |
| I1 | 조합 구간 밑줄(`.pe-edit-comp`), 캐럿 = 조합 끝, 확정 시 한 음절 | 통과: 밑줄 오른쪽 끝 = 캐럿 x, 확정 뒤 밑줄 없음, 확정 글자 합성 픽셀 확인 |
| I2 | 조합 문자열 비우기 → 조합 구간만 갱신 | 통과 |
| I3 | 줄 나눔은 리플로우가 하고 캐럿·밑줄은 프레임의 `ReflowSummary` 를 따른다 | 통과: 줄이 넘어간 뒤 캐럿 줄·x, 밑줄 위치 |
| I4 | 조합 중 클릭: `textarea.blur()` 로 `compositionend` 를 먼저 받고 이동. 조합 중 화살표는 무시 | 통과 |
| I5 | 조합 중 Ctrl+Z 무시(`keydown` 기본 동작 차단) | 통과: 조합이 유지되고 텍스트 불변 |
| I6 | `TextHistory`: 0.5초 정지·캐럿 이동·공백·문장부호 경계에서 단위가 끊김, 조합 확정 한 번은 같은 단위 | 통과(단위 시험 + e2e) |
| I7 | 한자 변환 결과 삽입, 글리프 없음은 `.pe-edit-missing` + `glyph-missing` 경고 표시 | 통과(가짜 호스트의 U+2603 = 없는 글자). 실제 한자 변환은 Windows 확인(8절) |
| I8 | 바깥 클릭: blur 로 조합 확정 → 커밋. 조합 중 Esc 는 종료 아님 | 통과 |

### 2.5 진입·종료·환경 변화

- 진입: 쪽을 열면 `getPageEditability` 를 받아 문단 위 마우스 오버에 테두리를 그린다. 더블클릭하면 `planParagraphEdit` → (`editable` 이면) `beginParagraphEdit`. 제한 문단은 `plan.limits[].detail`(없으면 `edit-labels.ts` 문구)을 팝오버로 보인다. revision 오류는 다시 판정해 한 번 더 시도한다. 한 번 클릭·드래그는 텍스트 층(M1)이 그대로 처리한다.
- 편집 중에는 텍스트 층·검색 하이라이트·디버그·레이아웃 오버레이를 숨긴다(옛 quad 가 낡아서).
- 바깥 클릭(문서 `mousedown` 캡처)은 커밋이다. `data-pe-keep` 가 붙은 요소(편집 영역·핸들·초과 패널·경고 패널·팝오버·"편집 취소"·폴백 토글·태그 설정)는 제외한다. 다른 도구 막대 버튼도 바깥 클릭이므로 먼저 커밋한다.
- 쪽 이동·Ctrl+S 는 초안을 먼저 커밋한다. 커밋이 복구로 편집을 이어 가야 하면(`restarted`) 이동·저장하지 않는다.
- 편집 중 창 크기·확대 변화는 쪽 캔버스를 다시 그리지 않고 보류했다가 편집이 끝난 뒤 반영한다(변경 영역 합성 기준 배율 유지).
- 커밋 뒤에는 영향 쪽의 추출 모델·레이아웃·편집 판정 캐시를 버리고 다시 그린다. 취소(변경 없는 커밋 포함)는 편집 전 렌더(`view.rendered`)로 캔버스를 복원한다(재렌더 없음).

### 2.6 저장(5.8)

`Ctrl+S`·저장 버튼은 모두 `prepareSave` 를 거친다: 초안 커밋 → `planSave({changes: []})`(변경 종류는 core 가 로그에서 더한다, D9) → `decideSave`.

| 판정 | 처리 |
| --- | --- |
| `heap.level = 'over-limit'` | 저장하지 않고 안내 창(코어 메시지 우선) |
| `heap.level = 'warn'` | 확인 창 |
| `edits.structureUnlinked > 0` | 확인 창(태그 쪽 구조 연결 끊김, D1) |
| `edits.pdfaDeclared` | 확인 창(PDF/A 적합성이 깨질 수 있음, 5.6) |
| 편집 쪽 번호 | 확인 창에 안내(파일 정보 `PdfEditorEdits` 에 기록됨) |

확인 창은 `<dialog>` 를 쓴다(임베디드 문맥에서 `window.confirm` 이 막힐 수 있다). 확인 창을 FSA 피커보다 먼저 띄우므로 대화상자 클릭이 사용자 활성화를 새로 준다.

### 2.7 복구(D6)

`ResilientPdf`(`recovery.ts`)가 `PdfWorkerApi` 를 감싼다.

- 치명 오류 판정(`isFatalWorkerError`): Worker `error`·`messageerror`(`WorkerCrash`), `RuntimeError`(wasm 트랩), 메모리 부족류 메시지. 일반 문서 오류(MuPDF 예외)·"미구현" 은 아니다.
- 복구 순서: 이전 Worker 종료 → 새 Worker → 보관한 `Blob` 열기 → 활성 로그(`EditLog.snapshot()`, `activeEditIds` 순서)를 `replayEdits` → `getEditHistory`. 같은 시각의 동시 실패는 복구 한 번만 한다.
- 읽기 RPC(렌더·추출·판정·`planSave` 등)는 복구 뒤 한 번 다시 시도한다. 쓰기·초안·저장·undo/redo 는 다시 시도하지 않고 `WorkerRecoveredError` 를 던진다. 복구 전 세대의 초안 id 호출은 새 Worker 로 보내지 않고 같은 오류를 돌려준다.
- 복구 알림 콜백은 복구가 끝난 뒤 비동기로 부른다(콜백 안 RPC 가 복구를 기다리는 교착 방지, 단위 시험으로 고정).
- 복구 자체가 실패하면 다음 `open` 까지 문서를 쓸 수 없다는 오류를 낸다(새 Worker 로 다시 시작).
- 뷰어 쪽: `EditSession` 이 복구 오류를 받으면 `planParagraphEdit` → `beginParagraphEdit` → 현재 모델로 `updateParagraphDraft`(초안 재시작), 알림 "복구 전 되돌리기 이력은 사라졌습니다". 커밋 중 복구되면 초안을 다시 시작하고 편집 모드를 유지한다. 저장 중이면 "다시 저장할까요?" 를 묻는다.
- 가정(통합 단계에서 확인): 복구 전후로 같은 `paragraphId` 가 같은 문단을 가리킨다(재적용 결정성, 계약 D6). Comlink 가 Worker 의 `RuntimeError` 의 `name` 을 보존한다.

### 2.8 확장 배포

| 항목 | 결과(2026-10-19) |
| --- | --- |
| 폴백 폰트 | `new URL('../../../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url)` 를 Worker 에서 fetch. 번들러가 `dist/assets/NotoSansKR-Regular-subset-<hash>.ttf` 로 내보낸다. 계약 수정 2 이후 파일: 4,082,236 B, sha256 `e96d7e43…`(수정 전 4,083,596 B·`08857b9f…`). `verify-dist` 는 원본 해시와 비교하므로 파일 교체에 영향이 없다 |
| `exposePdfWorker(self, { loadFallbackFont })` | `src/worker/pdf-worker.ts` 에서 구현 |
| harfbuzz wasm | 4.2절 |
| `verify-dist.mjs` | wasm 은 해시로 식별(MuPDF 항상 1개, harfbuzz 는 reflow 가 `harfbuzzjs` 를 import 할 때 1개, 그 밖은 오류). 폰트 1개 + 해시 일치 + Worker 진입 청크가 그 파일명을 참조. harfbuzz 코드가 `background.js`·`assets/viewer-*` 에 섞이지 않음. reflow 가 `harfbuzzjs` 를 import 하기 전에는 harfbuzz 검사를 건너뛰고 `SKIP` 을 출력한다(import 하는 순간 자동으로 검사한다) |

### 2.9 초과 처리(2026-10-20 사용자 결정, 이 절이 1절 표의 이전 "3선택" 을 대체)

| 항목 | 규칙 |
| --- | --- |
| 자동 확장 | 글이 영역 아래로 넘치면 리플로우가 아래 변을 글 높이까지(`areaLimit` 까지) 내린다(`ReflowSummary.area`). 사용자 선택 없음. reflow 가 하므로 커밋·undo·redo·`replayEdits` 가 같은 결과다(같은 편집 단위, 결정적) |
| 사용자 영역 | `ParagraphFormat.area` 는 사용자가 정한 영역 그대로다(자동 확장으로 바뀌지 않는다). 핸들 드래그의 기준은 화면의 영역(`reflow.area`)이고, 글보다 위로 올리면 다음 프레임에서 글 높이까지 다시 늘어난다 |
| 글자 줄이기 | 제거(`OverflowChoice`·`ParagraphFormat.overflow`·`ReflowSummary.fontScale` 없음) |
| 상한에 막힌 초과 | 초과 표시선, 영역 테두리 `data-overflow="1"`, 패널(`#pe-edit-overflow`)에 안내와 "되돌리기"(`#pe-edit-revert`) 하나, 경고 `overflow-clipped` |
| 되돌리기 | 이전 "그대로 두기" 자리. 도구 막대 "편집 취소" 와 같은 경로(`EditController.cancelActive`)로 이번 편집을 버리고 편집 시작 전 상태로 돌아간다 |
| 커밋 | 상한에 막힌 초과가 남아도 Esc·바깥 클릭은 커밋한다(`overflow-clipped` 경고 상태, 사용자 결정) |
| 이웃과 겹침 | 막지 않고 기존 `area-overlaps-content` 경고만 보인다 |
| 이전 문서·로그 | 이전 빌드가 쓴 `/PdfEditorFormat` 의 `overflow`('expand'·'shrink'·'keep')·`fontScale`, 뷰어 로그 `EditOp.format.overflow` 는 읽을 때 무시한다(pdf-ops `cleanParagraphFormat`). 축소로 쓴 블록도 다시 편집하면 원래 글자 크기 + 자동 확장으로 다시 배치된다 |

e2e(`edit-ui.spec.ts` "초과·영역"): 자동 확장·선택 UI 없음, 핸들로 줄여도 다시 늘어남, 상한 초과 표시·경고·"되돌리기" 하나, 되돌리기 = 취소 경로(캔버스 복원), 상한 초과 Esc 커밋, 영역 핸들(기존).

## 3. V7 결과(실측, 2026-10-19)

**재현된다.** Playwright 1.64.1 번들 Chromium 156.0.8078.4 에서 `Input.imeSetComposition`·`Input.insertText` 가 composition 이벤트를 만든다(`e2e/ime-cdp.spec.ts` 5건 통과, 일반 textarea 에서 이벤트 순서 기록).

| CDP 호출 | 이벤트 순서 |
| --- | --- |
| `imeSetComposition('ㅎ')`(첫 호출) | `compositionstart(data "")` → `compositionupdate("ㅎ")` → `beforeinput(insertCompositionText, isComposing)` → `input(insertCompositionText)` |
| `imeSetComposition('한')`(조합 중) | `compositionupdate` → `beforeinput` → `input`. textarea 값 안에서 앞 조합 문자열이 교체된다 |
| 조합 중 `insertText('한')` | `compositionupdate` → `beforeinput` → `input`(여전히 `isComposing`) → **`compositionend(data "한")`**. 확정 직전 `input` 도 `isComposing = true` |
| 조합 없이 `insertText('abc')` | `beforeinput(insertText, isComposing false)` → `input` |
| 조합 중 `blur()` | `compositionend(data = 조합 문자열)` 만 온다(추가 `input` 없음) |
| `imeSetComposition('')` | `compositionupdate("")` → `beforeinput` → `input(data null)` → `compositionend` |
| `keyboard.press('Backspace')` | `keydown` → `beforeinput(deleteContentBackward)` → `input` |

추가 실측: 조합 중 `keyboard.press` 의 `keydown` 은 `isComposing = true` 이다(Esc·ArrowLeft·Ctrl+Z). 조합 중 Ctrl+Z 를 막지 않으면 브라우저가 `historyUndo` 로 조합을 지운다(그래서 2.3절에서 막는다).

**CDP 로 재현되지 않는 것**: 실제 IME 의 `keydown`(`key = 'Process'`, `keyCode = 229`) 경로, 한자 변환 후보 창, 조합 중 `replacementStart/End`. `mapEditKey` 는 `isComposing` 과 `keyCode === 229` 둘 다 조합으로 보지만, 실제 MS 한글 IME 에서의 동작은 Windows 사용자 확인이 필요하다(8절).

### 3.1 시험 중 발견한 경합(수정함)

더블클릭으로 텍스트 층이 선택한 DOM 선택이 남아 있으면, 편집 시작 직후 IME 조합이 시작될 때 선택이 바뀌어 조합이 끊겼다(CDP 시험에서 `composition = null`). 편집 층이 열릴 때 `getSelection().removeAllRanges()` 후 textarea 에 포커스하도록 고쳤다. 실제 IME 에서도 같은 위험이 있어 코드에 남겼다.

## 4. chrome.* 확인 결과(실측, 2026-10-19)

### 4.1 전용 Worker 에서 `chrome.*`

`e2e/worker-chrome.spec.ts`: 확장 뷰어 페이지가 만든 전용 Worker(`public/diag/chrome-probe-worker.js`, 클래식)에서 확인.

| 항목 | 전용 Worker | 같은 확장 페이지 |
| --- | --- | --- |
| `typeof chrome` | `undefined` | — |
| `chrome.runtime`·`storage`·`downloads`·`declarativeNetRequest` | 모두 `undefined` | `runtime` object, `downloads` object, `storage` undefined(manifest 에 권한 없음) |
| 확장 자산 `fetch`(폴백 폰트 `chrome-extension://…/assets/NotoSansKR-….ttf`) | 200, 4,082,236 B(계약 수정 2 이후 파일, 최초 실측은 4,083,596 B), 앞 4바이트 `00 01 00 00`(TrueType) | — |
| `manifest.json` `fetch` | 200 | — |

**결론**: 전용 Worker 에서 `chrome.*` 는 쓸 수 없다. `fetch(new URL(…, import.meta.url))` 로 확장 자산을 받는 방식은 된다. 실제 `pdf-worker` 도 확장 페이지가 만든 전용 module Worker 이므로 같은 환경이다. 그래서 폴백 폰트 로더는 `chrome.runtime.getURL` 없이 상대 URL 만 쓴다(`pdf-worker.ts`). 확장 페이지의 `chrome.*` 는 뷰어(메인 스레드)가 쓴다.

### 4.2 harfbuzz wasm 번들(실험)

reflow 가 아직 `harfbuzzjs` 를 import 하지 않아(S2 진행 중) 정식 산출물에는 harfbuzz 가 없다. 번들 동작은 임시 실험으로 확인했다(커밋하지 않음): Worker 그래프에서 `packages/reflow/node_modules/harfbuzzjs/dist/index.mjs` 를 import 하는 임시 모듈을 추가해 `vite build`.

- `harfbuzz.js` 안의 `new URL("harfbuzz.wasm", import.meta.url)` 를 번들러가 감지해 `dist/assets/harfbuzz-<hash>.wasm` 을 내보낸다. 433,766 B, sha256 `684bda29aee2…` = 원본 `harfbuzz.wasm` 과 같다. **vite 설정 추가 없이** 된다.
- 경고 `Module "module" has been externalized for browser compatibility`(harfbuzz.js 의 Node 분기 `import("module")`)는 MuPDF 와 같은 종류이며 브라우저 실행 경로(`ENVIRONMENT_IS_NODE` 거짓)에서는 쓰이지 않는다.
- `verify-dist.mjs` 의 harfbuzz 검사를 두 방향으로 확인했다: harfbuzz 없는 dist 에 "reflow 가 사용함" 으로 강제하면 실패(wasm 누락·개수·청크 없음), 실험 dist 에서는 통과.
- harfbuzzjs 는 `reflow` 의 의존성이고 확장은 직접 의존하지 않는다(pnpm 엄격). 그래서 확장 쪽에서 `harfbuzzjs/...wasm?url` 로 명시 참조하지 않고, reflow 가 import 하면 번들되는 경로에 맡긴다.
- 최상위 `await`: `harfbuzzjs/dist/index.mjs` 가 `init(await createHarfBuzz())` 를 쓴다(빌드 target `chrome128` 지원). `exposePdfWorker` 는 Comlink 리스너를 먼저 등록하고 `session` 을 동적 import 하므로, reflow 가 `session` 쪽에서 import 되는 한 Worker 메시지 유실 문제는 없다(M1 주석의 규칙 유지).

## 5. 통합 시 켤 e2e 목록

실제 core 편집 RPC 가 필요한 시험은 `apps/extension/e2e/edit-integration.spec.ts` 의 `test.skip(true, …)` 한 줄을 지우면 켜진다(본문은 가짜 호스트 시험과 같은 DOM 식별자·`?e2e` 이음매 `window.__pe` 를 쓰며, 통합 전에는 실행한 적이 없다). 문서는 `public/diag/m0-sample.pdf`(영문 1쪽).

| # | 시험 | 켜는 조건 | 기대값·근거 | 조정 가능성 |
| --- | --- | --- | --- | --- |
| 1 | DoD 흐름: 한글 조합 → 확정 → Esc 커밋 → 저장(downloads) → 재열기 → 재추출 텍스트에 '한' → 같은 문단 새 세션 재편집 | S1·S2·S3 머지 | 재추출 텍스트에 입력 포함, 재편집 시작 텍스트에 '한' 포함(계약 1.1, 5.3) | 첫 편집 가능 문단 선택 방식, 입력 텍스트 |
| 2 | 반응 시간: 43글자를 한 글자씩 입력, `pe-edit-latency` p95 | 위 + V8(영역 렌더 시간) | 잠정 목표 p95 ≤ 100 ms(계약 1.1). 첫 측정 뒤 메인 세션이 사용자 확인을 받아 고정 | **측정 후 기준 조정**(8.4 모집단은 고정 문단 10개 × 텍스트 3종이므로 이 시험은 스모크) |
| 3 | 폴백(한글)·없는 글자 경고가 실제 plan/draft 경고와 일치 | 위 | `font-fallback` 경고, `.pe-edit-fb`, 사설 영역 글자 → `.pe-edit-missing` + `glyph-missing` | 경고 문구·종류 |
| 4 | Worker 치명 오류 → 복구 → `replayEdits` 결과 = 복구 전 화면 | S3 `replayEdits`·재적용 결정성 | 복구 알림이 뜨고 편집 반영 화면(`toDataURL`)이 같다 | 화면 비교 대신 재추출 텍스트 비교로 완화 가능 |

별도 정리 대상: `extension-save.spec.ts` 의 "M3 편집 RPC 가 미구현인 동안: 편집만 꺼진다" 는 core 가 편집 RPC 를 구현하면 스스로 건너뛴다(`test.skip(조건)`). 통합 뒤 삭제해도 된다.

켜지 않는 시험(계속 유지): `edit-ui.spec.ts` 37건(가짜 편집 호스트), `ime-cdp.spec.ts` 5건, `extension-save.spec.ts` 8건, `worker-chrome.spec.ts` 1건.

테스트 작성용 DOM 식별자: `#pe-edit-entry`(`#pe-edit-hover[data-editable]`, `#pe-edit-popover`), `#pe-edit-layer`(`data-draft-id`·`data-updating`·`data-committing`·`data-composing`) > `#pe-edit-area[data-area][data-overflow]`, `#pe-edit-caret[data-offset][data-x][data-line]`, `.pe-edit-sel`, `.pe-edit-comp`, `.pe-edit-fb`, `.pe-edit-missing`, `.pe-edit-handle[data-handle]`, `#pe-edit-overflow`(`#pe-edit-revert`), `#pe-edit-overflow-line`, `#pe-edit-warnings li[data-kind]`, `#pe-edit-tagged-note`, `#pe-edit-input`. 도구 막대: `#pe-doc-undo`·`#pe-doc-redo`·`#pe-edit-cancel`·`#pe-fb-toggle`·`#pe-block-tagged`·`#pe-edit-notice`. 확장: `#notice-bar [data-notice]`, `#app-dialog [data-dialog-button]`. `viewer.html?e2e` 일 때만 `window.__pe`(`pdf`·`editLog`·`controller`) 노출.

## 6. 계약 불일치·확인 요청(메인 세션)

| # | 내용 | 근거(2026-10-19) | 뷰어 처리 | 제안 |
| --- | --- | --- | --- | --- |
| 1 | `beginParagraphEdit(pageIndex, paragraphId, revision)` 에 렌더 배율 인자가 없는데 결과 `BeginEditResult.first` 는 `RenderedPage`(영역 렌더)를 포함한다 | `shared-types/src/rpc.ts`·`edit.ts`. 가짜 호스트 e2e 에서 배율 1 로 렌더한 `first.region` 을 배율 1.5 캔버스에 합성하자 글리프가 엉뚱한 위치에 놓이거나 사라졌다(수정 전 실패 실측) | `first.region` 은 쓰지 않는다. 시작 직후 `updateParagraphDraft` 를 한 번 보내 뷰어 배율의 영역을 받는다(RPC 1회 추가) | `beginParagraphEdit` 에 `renderScale` 를 더하거나, `first.region` 을 선택 필드로 두고 배율이 `DraftInput.renderScale` 과 같다고 명시 |
| 2 | **`listRedactAnnots` 가 RPC 로 없다**(A2-2 열기 시 보고) | pdf-ops 에는 `listRedactAnnots(doc)` 가 있으나 `PdfWorkerApi`·`OpenResult`·core 어디에도 노출되지 않는다 | `ResilientPdf.listRedactAnnots()` 가 RPC 를 시도하고 없으면 `null` → 알림 없이 진단 로그 `redact-report-unavailable` 만 남긴다. 알림 문구·표시·e2e(가짜 보고)는 구현·시험했다 | `PdfWorkerApi` 에 `listRedactAnnots(): Promise<{ total: number; pages: number[] }>`(또는 `OpenResult.redact`)를 추가하고 core 가 pdf-ops 결과를 돌려주게 한다. 추가되면 뷰어는 무변경(이미 호출함) |
| 3 | `PlacedLine.[start, end)` 가 강제 줄바꿈 글자 `\n` 을 포함하는지 불명 | `edit.ts` 주석은 "이 줄 텍스트 위치 [start, end)", `hardBreak` 는 "강제 줄바꿈으로 끝남" | 포함·미포함 둘 다 같은 결과가 나오게 구현(`lineVisibleEnd`)하고 두 규약을 단위 시험으로 고정 | 계약에 한쪽을 명시 |
| 4 | `PlacedLine.ascent`·`descent` 의 부호·단위 불명 | 같은 곳 | 양의 거리(pt)로 보고 `abs` 를 쓴다. 캐럿 상자 = `baseline − ascent … baseline + descent` | 명시 |
| 5 | `DraftUpdate.warnings` 가 계획 경고(`plan.warnings`)를 포함하는지 불명 | `edit.ts` | `plan.warnings ∪ draft.warnings` 를 (종류, 메시지)로 중복 제거해 표시 | 명시 |
| 6 | `PlacedGlyph` 의 `x` 가 정렬(justify)·커닝 반영 후 글리프 원점인지, 줄 끝 공백 글리프를 포함하는지 불명 | `edit.ts` | 글리프 `x`·`advance` 를 그대로 쓰고, 소프트 줄바꿈 줄의 줄 끝 공백 구간은 줄 오른쪽 끝(`x1`)에 접는다 | 명시 |
| 7 | 복구 뒤 같은 `paragraphId` 가 같은 문단이라는 가정(D6 재적용 결정성) | 계약 D6 "통합 단계 테스트" | `EditSession.restart` 가 `planParagraphEdit(pageIndex, paragraphId)` 로 새 revision 을 받아 초안 재시작 | 통합 e2e #4 로 확인 |
| 8 | Worker wasm 트랩의 오류 이름 | Comlink 오류 복원 방식에 기대 | `name === 'RuntimeError'`·메시지 정규식으로 치명 판정(`isFatalWorkerError`). 실제 OOM·트랩에서 이름이 보존되는지는 미실측 | 통합 단계에서 실제 오류로 확인(필요하면 core 가 치명 오류를 표시하는 필드를 둔다) |
| 9 | `PdfWorkerApi.undo()`/`redo()` 결과의 `affectedPages` 가 비어 있으면(변화 없음) 뷰어는 다시 그리지 않는다 | 계약 4절 | `invalidatePages(affectedPages)` | 확인 |
| 10 | 5.7 전용 Worker 의 `chrome.*` | 4.1절 실측 | 사용 불가 확정 | 계약 5.7 의 괄호("S4 가 확인")를 이 결과로 닫는다 |

## 7. 검증 결과(2026-10-19, 이 worktree)

| 항목 | 결과 |
| --- | --- |
| `pnpm exec turbo run build typecheck test test:e2e --force` | **통과**(25개 작업 모두 성공, 종료 코드 0, 캐시 0). `verify-dist`: MuPDF wasm·폴백 폰트 OK, harfbuzz 는 reflow 연결 전이라 `SKIP` 출력 |
| 단위 시험 | viewer-ui 16 파일 **225건**(편집 모델·텍스트·기하·세션·코디네이터·키·로그 + 기존), extension 5 파일 **43건**(복구 계층·저장 판정·알림 + 기존) |
| `pnpm lint` | 통과 |
| `pnpm exec prettier --check .` | 통과 |
| e2e | 전체 **81건 통과, 5건 skip**(통합용 `edit-integration.spec.ts` 4건 + 기존 M1 동적 skip 1건). 신규: `edit-ui.spec.ts` 37건, `ime-cdp.spec.ts` 5건, `extension-save.spec.ts` 8건, `worker-chrome.spec.ts` 1건. 기존 M0·M1·dnr-legacy 시험 무변경. `edit-ui.spec.ts` 는 6회 반복(222건)에서 실패·불안정 없음 |

## 8. 남은 제한과 사용자(Windows) 확인

| # | 제한·확인 | 비고 |
| --- | --- | --- |
| 1 | 실제 core 편집 RPC 로 검증하지 않았다(가짜 편집 호스트의 단순 리플로우: 일정 폭, 공백 뒤 줄 나눔) | 통합 e2e(5절) |
| 2 | **MS 한글 IME 실제 입력**: 조합 중 `keydown`(keyCode 229) 경로, 한자 변환(I7), 조합 중 클릭·Esc·Ctrl+Z, IME 후보창 위치(textarea 를 캐럿에 둠) | 계약 7절 5번. CDP 는 합성 이벤트만 만든다(3절) |
| 3 | 임베디드 MIME handler 문맥(`<embed>`·`<iframe>`·`<object>`)에서 편집 포커스·키 입력. 프레임 포커스 보강(`window.focus()`)은 넣었으나 실제 임베디드 문맥은 미확인 | M1 실측(텍스트 층)과 같은 문제 가능 |
| 4 | Ctrl+S 편집 문서 덮어쓰기(A10) | 사용자 확인 |
| 5 | 128–149 DNR 경로의 file:// 안내(A5-3): 판정은 단위 시험, 실제 Chrome 128–149 에서의 표시는 미확인 | 사용자 PC 의 Chrome 이 155 뿐(코퍼스 W8) |
| 6 | 단일 페이지 보기만 지원, 편집은 쪽 하나씩. 회전 쪽·원점이 0 이 아닌 쪽은 좌표 변환 단위 시험만 했다 | |
| 7 | 문단 간 밀어내기·모양 바꾸기 UI·빈 곳에 새 문단은 범위 밖(계약 1.4) | |
| 8 | 옛한글 등 폴백에 없는 글자는 `glyph-missing` 표시만 한다(조합 중 표시 포함) | D12 |
| 9 | 키보드 접근성(스크린 리더 낭독)은 다루지 않았다 | |

## 9. Action Item

| # | 내용 | 담당 |
| --- | --- | --- |
| 1 | 6절 #1(`beginParagraphEdit` 배율)·#2(`listRedactAnnots` RPC)·#3–#6(리플로우 요약 규약) 결정 | 메인 세션 |
| 2 | S1·S2·S3 머지 뒤 5절 e2e 4건 활성화·측정, 반응 시간 기준 고정은 사용자 확인 | 메인 세션 |
| 3 | reflow 가 `harfbuzzjs` 를 import 하는 커밋을 머지한 뒤 `pnpm --filter @pdf-editor/extension build` 로 `verify-dist` 의 harfbuzz 검사(자동 활성화)가 통과하는지 확인 | 메인 세션 |
| 4 | 통합 뒤 `extension-save.spec.ts` 의 "M3 미구현" 시험 삭제 | 메인 세션 |
| 5 | Windows Chrome: MS 한글 IME 실제 입력·한자 변환·조합 중 클릭/Esc/Ctrl+Z, 임베디드 문맥 편집, Ctrl+S 덮어쓰기 | 사용자 |
| 6 | PLAN.md 5.7 문구: 전용 Worker 의 `chrome.*` 사용 불가(4.1절) 반영 | 메인 세션 |

## 10. 변경 파일

- `packages/viewer-ui/src/`: `edit-text.ts`, `edit-model.ts`, `edit-geometry.ts`, `edit-keys.ts`, `edit-paint.ts`, `edit-labels.ts`, `edit-log.ts`, `edit-session.ts`, `edit-controller.ts`(새), `components/EditEntry.tsx`·`EditorLayer.tsx`(새), `controller.ts`·`failure.ts`·`viewer-host.ts`·`index.ts`·`style.css`·`components/Controls.tsx`·`components/PageSurface.tsx`(수정)
- `packages/viewer-ui/test/`: `edit-text`·`edit-model`·`edit-geometry`·`edit-keys`·`edit-log`·`edit-session`·`edit-controller` 시험(새), `fake-edit-host.ts`(새, e2e 하니스 공용), `failure.test.ts`(수정)
- `apps/extension/src/viewer/`: `recovery.ts`·`save-plan.ts`·`notices.ts`·`dialog.ts`(새), `main.ts`·`viewer.css`(수정), `viewer.html`(알림 줄·`<dialog>`)
- `apps/extension/src/worker/pdf-worker.ts`(폴백 폰트 로더), `scripts/verify-dist.mjs`, `public/diag/chrome-probe-worker.js`(새, 진단)
- `apps/extension/test/`: `recovery.test.ts`·`save-plan.test.ts`(새)
- `apps/extension/e2e/`: `edit-harness.ts`·`edit-ui.spec.ts`·`edit-integration.spec.ts`·`ime-cdp.spec.ts`·`extension-save.spec.ts`·`worker-chrome.spec.ts`(새)
