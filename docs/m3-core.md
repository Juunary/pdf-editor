# M3 core: 편집 세션(저널·로그·초안·저장·복구)과 영역 렌더

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-19 |
| 범위 | `docs/m3-contract.md` 작업 S3(core): 4절 RPC, D6·D7·D9, 5.7·5.8, 6.1 V1(전반)·V8, 11절 |
| 브랜치 | `m3-core` (기준: `m3` 브랜치 a7464f1) |
| 환경 | 서버 Node 22.18, mupdf 1.28.1. 브라우저·Windows 는 미측정. pdf-ops·reflow 의 M3 함수는 "M3 미구현"이라 가짜 어댑터로 검증 |
| 재현 | `pnpm --filter @pdf-editor/core test`(전체), `pnpm --filter @pdf-editor/core build` 후 `node packages/core/scripts/measure-m3.mjs region <코퍼스 폴더> 24 7`, `node --expose-gc packages/core/scripts/measure-m3.mjs journal-heap｜journal-stream｜journal-oneop ...`(스크립트 머리말 참고) |

## 1. 상태

| 항목 | 상태 |
| --- | --- |
| 편집 RPC 11개 | 구현. `getPageEditability`·`planParagraphEdit`·`getPageEdits`·`beginParagraphEdit`·`updateParagraphDraft`·`commitParagraphEdit`·`cancelParagraphEdit`·`undo`·`redo`·`getEditHistory`·`replayEdits` |
| 저널·로그 | 문단 편집 하나 = 저널 작업 하나, 취소 = `abandonOperation`, `revision`·`activeEditIds`, `getEditHistory` 는 core 상태로 응답 |
| D9 저장 | `beginOperation('save')` → `finalizeForSave`(폴백 사용 시) → `saveToBuffer` → `abandonOperation`. **Info 기록은 계약과 달리 커밋 작업 안에서 한다**(2.4). `SavePlan.edits`·`changes` 합산·전체 저장 승격 구현 |
| 5.7 | 커밋·취소·갱신·undo·redo 때 쪽 캐시 무효화(±2쪽 레이아웃 포함), 초안 상태 기준 렌더·추출·검색, 편집 블록 목록 재구성 |
| 영역 렌더 | `RenderRequest.clip`·`RenderedPage.clip` 구현(픽셀 격자 정렬) |
| 폴백 로더 | `loadFallbackFont` 를 첫 편집 계열 호출에서 await, FontManager 에는 동기 로더로 전달 |
| D6 복구 | `replayEdits` 는 저널을 끈 상태로 적용한 뒤 저널을 켠다. 재적용 결정성 비교 틀(`snapshot`) 작성 |
| V1 전반 | 확인됨. 단 **계약 D4·D9 와 어긋나는 MuPDF 동작 3건**을 발견하고 core 에서 우회·보정했다(2.2–2.4, 5절) |
| V8 | 확인됨. 문단 영역 렌더는 코퍼스 48쪽에서 중앙값 2 ms, 쪽별 p95 최대 77 ms(2.6) |
| 미완 | 실제 pdf-ops·reflow 연결 검증, V1 후반(재적용 결과 비교), S1 FontManager 와의 폴백 수명 확인은 통합 단계(4절) |

## 2. 실측 (2026-10-19, 서버 Node 22.18, mupdf 1.28.1)

재현 코드: `packages/core/test/journal-v1.test.ts`(MuPDF 만 사용, 10건), `packages/core/test/edit-save-replay.test.ts`(core 경유, 17건), `packages/core/scripts/measure-m3.mjs`.

### 2.1 V1 전반 결과

| 시나리오 | 결과 | 근거 |
| --- | --- | --- |
| 편집 블록 Form 추가 + 쪽 콘텐츠 스트림 교체 + 쪽 Resources 등록 → undo/redo | 통과. undo 로 잉크 픽셀·객체·Resources·Contents 가 작업 전 상태, redo 로 복원. 작업 중 `canUndo()`·`getJournal()` 은 예외(`Can't undo/redo during an operation`), 저널이 켜진 뒤 작업 밖 객체 추가는 예외(`Can't add a journal fragment absent an operation`) | journal-v1 1번 |
| 같은 블록 스트림을 한 작업 안에서 20번 쓰기 | 저널 단계 1개. undo 는 작업 전 내용으로. 중간 내용은 저널이 보유하지 않음 | journal-v1 2번, 2.5 |
| 렌더·구조화 텍스트·`loadPage` | 저널 단계를 만들지 않음 | journal-v1 3번 |
| 폰트 추가 후 abandon 또는 undo | 객체가 xref 에서 사라짐. **같은 바이트로 다시 `addFont` 하면 끊긴 참조가 돌아옴**(2.2). 바이트에 salt 를 덧붙이면 새 객체 | journal-v1 4번 |
| 폴백을 넣은 초안 취소 뒤 새 편집 | salt 적용 시 통과(저장·재열기 뒤 글자·잉크 일치). core 경유 시험도 통과 | journal-v1 7번, save-replay 2번 |
| 폴백을 넣은 편집 undo 뒤 새 편집 → 저장 | salt 적용 시 통과 | journal-v1 8번, save-replay 3번 |
| D9 저장 순서 뒤 undo/redo | 통과. 감싼 저장은 저널 단계를 만들지 않고(`position 1, steps ['edit']` 유지) 저장 직후 첫 undo 가 유효. 출력에는 Info 기록·폴백 서브셋(4,083,596 B → 1/10 미만)이 들어가고 작업 문서는 전체 폰트 유지. 저장 작업 안에서 Info 를 바꾸는 계약 순서는 undo 직후 저장에서 redo 를 잃는다(2.4) | journal-v1 9번·13번, save-replay |
| 감싸지 않은 `objstms` 저장 | 저널에 `Save document` 단계가 생기고 저장 직후 첫 undo 가 화면을 바꾸지 못함(D9 가 필요한 이유) | journal-v1 10번 |

### 2.2 발견 1: 폰트 리소스 표가 되돌린 폰트의 끊긴 참조를 돌려줌 (계약 D4 불일치)

- 현상(MuPDF 1.28.1): `doc.addFont(new Font(name, bytes))` 는 폰트 바이트 다이제스트를 키로 문서의 폰트 리소스 표를 조회하고, 있으면 그 객체를 돌려준다. 저널 `abandonOperation`·`undo` 가 폰트 객체를 xref 에서 지워도 표 항목은 남는다. 같은 바이트로 다시 넣으면 같은 객체 번호(관측: 7 0 R)가 돌아오지만 객체는 없다.
- 증상: `ref.get('Type')` = null, `ref.put(...)` = `not a dict (null)`, 그 참조를 리소스에 넣은 채 저장하면 `TypeError`. 같은 이름·같은 `mupdf.Font` 객체를 쓰든 이름만 바꾸든 동일. 폰트가 이미 문서에 있고 유효하면(커밋된 편집이 넣은 것) 같은 객체를 정상 반환한다.
- 계약 D4 의 "assign 때마다 객체가 있는지 확인하고 없으면 현재 작업 안에서 다시 넣는다"만으로는 위 두 V1 시나리오가 실패한다.
- 우회(core, `edit-util.ts` `saltedFontBytes`): FontManager 에 넘기는 동기 로더가 부를 때마다 폴백 바이트 끝에 4바이트 카운터를 덧붙인 사본을 돌려준다(첫 호출은 원본 그대로). 다이제스트가 달라져 새 객체가 생긴다. TrueType 은 마지막 테이블 뒤 여분 바이트를 무시하고 서브셋(`subsetFontBytes`)은 gid 를 유지하므로 렌더·추출이 같다(save-replay 시험에서 재열기 뒤 글자 확인).
- S1(pdf-ops FontManager)에 대한 요구: ① 폴백 폰트를 다시 넣을 때마다 `loadFallback()` 을 호출하고 그 바이트로 `new Font` 를 만든다. ② 바이트나 `mupdf.Font` 를 캐시해 재사용하지 않는다. 이 둘이 깨지면 core 의 salt 가 무효가 된다. 대안은 FontManager 가 직접 salt 하는 것이다. 메인 세션에 2026-10-19 통보했다.

### 2.3 발견 2: Info 를 작업 안에서 만들면 취소·undo 때 trailer 가 끊김 (계약 D9 불일치)

- 현상: `trailer.put('Info', ref)` 는 저널에 기록되지 않는다. 작업 안에서 Info 객체를 만들고 `abandonOperation`(또는 커밋 뒤 undo)하면 Info 객체만 사라지고 trailer `/Info` 는 끊긴 참조로 남는다(`get('Info').isIndirect()` true, `resolve()` null). 계약 11절은 저장 작업 안에서 만든 경우만 확인했고, 첫 편집 작업 안에서 만들어도 같다.
- 이미 있는 Info 사전의 키 추가는 저널에 기록된다. 작업 안의 `recordEditMetadata` 는 abandon 뒤 원상태로 돌아오고, 커밋한 작업 안의 기록은 undo·redo 와 함께 움직인다.
- 처리(core): Info 가 없으면 **저널을 켜기 직전(작업 밖)** 에 만든다(`ensureInfoDictionary`). 이후 어떤 undo·취소로도 Info 는 사라지지 않는다. 첫 편집 RPC(`getPageEditability`·`planParagraphEdit`·`beginParagraphEdit`) 또는 `replayEdits` 시작에서 한다. 판정만 하고 편집하지 않은 문서에도 빈 Info 사전이 생길 수 있으나 저장 결과에는 무해하다.
- 함정: 객체를 추가하면 MuPDF 가 새 xref 구간을 만들어 `getTrailer()` 가 새 사전이 된다. **먼저 받아 둔 trailer 에 `put` 하면 현재 trailer 에 반영되지 않는다**(`journal-v1` 6번, Info 는 5번). `trailer.put` 은 `addObject` 뒤에 `getTrailer()` 를 새로 불러 해야 한다. S1 `recordEditMetadata` 도 같은 순서를 지켜야 한다.

### 2.4 발견 3: 작업 안의 첫 변경이 redo 단계를 버림 (계약 D9 불일치)

- 현상: undo 로 redo 가 가능한 상태에서 `beginOperation` 은 redo 를 건드리지 않고, 작업 안에서 객체를 **처음 바꾸는 순간** MuPDF 가 redo 단계를 버린다. 그 작업을 `abandonOperation` 해도 돌아오지 않는다(`journal-v1` "undo 뒤 redo 단계 보존" 3건).

| 동작 (undo 로 redo 가능한 상태에서) | redo |
| --- | --- |
| 변경 없는 작업을 열고 버림·닫음 (판정 probe) | 유지 |
| 작업 안에서 객체를 바꾸고 `abandonOperation` | **사라짐** (`position 1, steps ['edit-A']`) |
| 작업 안에서 객체를 바꾸고 `endOperation` | 사라짐 (새 단계로 대체, 일반적인 편집 의미) |
| 변경 없는 감싼 저장 (`beginOperation('save')` → `saveToBuffer` → `abandonOperation`) | 유지 |
| D9 순서 그대로: 저장 작업 안에서 Info 키를 바꾸고 저장 → abandon | **사라짐** |

- 영향: 계약 D9 의 저장 순서(Info 기록을 저장 작업 안에서)대로 하면 undo 직후 저장할 때마다 redo 가 사라진다. 초안을 시작하면(원 문단 제거·블록 삽입이 문서를 바꾸므로) redo 가 사라지고, 초안을 취소해도 돌아오지 않는다.
- 처리(core)
  - **Info 기록(`recordEditMetadata`)을 저장 작업이 아니라 커밋 작업 안에서 한다**(계약 D9·5.6 과 다름). 기록이 저널에 남아 undo·redo 와 함께 움직이므로 Info 는 항상 활성 편집 쪽을 가리키고, 저장 작업은 문서를 바꾸지 않는다. 재적용은 끝에서 한 번 기록한다(저널 끈 상태). `/ModDate` 는 마지막 커밋 시각이 된다.
  - 저장 작업이 문서를 바꾸는 경우는 폴백 폰트를 쓴 활성 편집이 있어 `finalizeForSave`(서브셋 교체)를 부를 때뿐이다. 이때 undo 직후 저장은 redo 를 잃는다. 서브셋을 건너뛰면 redo 는 남지만 저장 파일에 전체 폰트(약 4 MB)가 들어가 A7-1(저장 시 서브셋)에 어긋나므로 서브셋을 택했다.
  - core 의 redo 스택은 MuPDF 와 맞춘다: 초안 시작 성공 때 비우고, 판정·저장·취소·시작 실패의 작업을 버린 직후 `doc.canRedo()` 로 확인해 사라졌으면 비운다. `getEditHistory().canRedo` 가 항상 실제 `redo()` 가능 여부와 같다.
- 시험: `edit-save-replay.test.ts` "redo 단계 보존" 4건, `edit-walk.test.ts`(임의 순서 6시드 × 40단계, 매 단계 저널 위치·단계 수 = 로그).
- 대안(미구현): 사라진 redo 항목을 어댑터로 다시 적용해 단계를 복원(재적용 결정성 의존). 저장 후 redo 보존이 요구되면 검토한다.

### 2.5 저널 메모리 증가량

방식: `--expose-gc` 로 JS 래퍼 쓰레기를 치운 뒤 WASM 힙 증가를 잰다(`journal-stream`: 작업마다 스트림 하나 교체, `journal-heap`: 작업마다 쪽 콘텐츠 교체 + 편집 블록 스트림 20번 쓰기, `journal-oneop`: 한 작업 안 반복 쓰기). 힙은 단계적으로 늘고 줄지 않아 값은 계단 형태다(같은 175.06 MiB 가 두 구성에서 나온 것은 그 때문).

| 구성 | 힙 증가 | 작업당 |
| --- | --- | --- |
| 저널 끔, 195 KB 스트림 500번 교체(`journal-stream`) | 0.00 MiB | 0 |
| 저널 켬, 같은 구성 | 92.00 MiB | 188.4 KiB(교체한 스트림 크기의 약 0.97배) |
| 쪽 콘텐츠 559.6 KB, 100작업 | 43.94 MiB | 449.9 KiB |
| 쪽 콘텐츠 559.6 KB, 300작업 | 175.06 MiB | 597.5 KiB |
| 쪽 콘텐츠 1,700.7 KB, 100작업 | 175.06 MiB | 1,792.6 KiB |
| 쪽 콘텐츠 55 KB, 100작업 | 0 (측정 한계) | 기존 여유 힙에 흡수 |
| 한 작업 안에서 195 KB 스트림 200번 쓰기(`journal-oneop`) | 0.00 MiB | 중간 내용은 보유하지 않음 |
| undo 100–300단계 | 0.1–0.2 ms | 포인터 교체 |

- 해석: 저널은 작업마다 교체된 객체(쪽 콘텐츠 스트림)의 작업 전 내용을 보유한다. 문단 편집은 쪽 콘텐츠를 한 번 고치므로 작업당 보유량은 그 쪽 콘텐츠 크기 정도다. 편집 중 글자 입력은 한 작업 안이라 누적되지 않는다.
- 위험: 콘텐츠 1.7 MB 쪽을 100번 편집하면 약 175 MiB(힙 상한 2 GiB 의 약 9%). 단계 수를 제한하는 MuPDF API 는 없다(오래된 단계를 버리는 호출 없음). 단계 상한 정책은 결정하지 않았고 4절에 남겼다.

### 2.6 V8: 영역 렌더 시간

방식: 코퍼스 24문서 × 쪽 2개(1·4쪽, 48쪽). 쪽마다 쪽 전체와 영역 3종을 배율 1.5·2 로 렌더, 첫 호출은 제외하고 7회 반복해 쪽별 p50·p95. 서버 Node, MuPDF DrawDevice RGB. 코퍼스 PDF 는 읽기만 했다(`/mnt/nas4/kjune/pdf-editor/fixtures/corpus`).

| 구성 | 쪽수 | 쪽별 p50 의 중앙값 | 쪽별 p50 의 p95 | 쪽별 p95 의 최대 |
| --- | --- | --- | --- | --- |
| 쪽 전체 @1.5 | 48 | 6.0 ms | 44.4 ms | 115.8 ms |
| 문단 한 줄(300×14 pt) @1.5 | 48 | 1.9 ms | 10.3 ms | 75.6 ms |
| 문단 6줄(400×80 pt) @1.5 | 48 | 2.1 ms | 11.8 ms | 76.4 ms |
| 반 쪽(300×400 pt) @1.5 | 48 | 3.3 ms | 31.5 ms | 82.2 ms |
| 쪽 전체 @2 | 48 | 9.3 ms | 60.8 ms | 198.8 ms |
| 문단 한 줄 @2 | 48 | 2.0 ms | 11.6 ms | 75.0 ms |
| 문단 6줄 @2 | 48 | 2.4 ms | 13.2 ms | 77.1 ms |
| 반 쪽 @2 | 48 | 3.9 ms | 48.0 ms | 85.4 ms |

- 문단 단위 영역 렌더는 대부분의 쪽에서 2–13 ms 다. 8.4 의 잠정 목표 p95 100 ms(입력 → 합성)에서 렌더 구간은 여유가 있다.
- 예외: 콘텐츠 스트림이 큰 쪽은 영역이 작아도 시간이 줄지 않는다. 콘텐츠 해석은 영역과 무관하게 전체를 읽기 때문이다. 관측: `kogl-mods-cpi-202609.pdf` 4쪽(콘텐츠 3,800 KB) 쪽 전체 100.8 ms → 문단 영역 76.6 ms. 이런 쪽은 렌더만으로 예산의 약 3/4 를 쓴다. 반대로 `nasa-se-handbook-sp2016-6105.pdf` 1쪽은 쪽 전체 191.9 ms → 문단 19.5 ms(이미지 컬링).
- 개선 후보(미구현): 편집 블록을 뺀 나머지를 DisplayList 로 한 번 만들어 두고 영역만 다시 그리는 방식. 콘텐츠가 큰 쪽의 목표 미달이 통합 측정에서 확인되면 검토한다.
- 영역 렌더의 픽셀은 같은 배율 쪽 전체 렌더의 같은 위치 픽셀과 일치한다(회전 90·270, 배율 1·1.5·2 시험).

## 3. 설계

### 3.1 구성

| 파일 | 내용 |
| --- | --- |
| `src/edit-engine.ts` | `EditEngine`: 저널 작업·로그·초안·저장 감싸기·재적용. 오류 `EditStateError`, `StaleRevisionError` |
| `src/edit-adapter.ts` | `EditAdapter`(pdf-ops·reflow 편집 함수 경계), `defaultEditAdapter` |
| `src/edit-util.ts` | 사각형·경고 합성·폴백 salt·PDF/A 선언 검사·Info 보장 |
| `src/session.ts` | `PdfSession`: 쪽 캐시(linkage 캐시 추가), 영역 렌더, `planSave`·`save`, 편집 RPC 위임 |
| `src/render.ts` | `renderPageRegionRgba` |
| `test/fake-edit-adapter.ts` | 가짜 어댑터(실제 MuPDF 문서에 Form 편집 블록을 쓴다) |

`PdfSessionOptions` 에 `editAdapter`(기본은 실제 구현)와 `createId`(편집 id·초안 id 생성, 시험에서 고정)를 더했다. 둘 다 내부·시험용이다. `worker-api.ts`·`worker.ts` 는 바꾸지 않았다.

### 3.2 상태 모델

- 로그: `base`(재적용한 편집, undo 불가) + `undo` 스택 + `redo` 스택. 저널 단계와 `undo`·`redo` 스택이 1:1 이다. undo 직전에 `doc.canUndo()` 로 어긋남을 검사한다.
- `revision`: 커밋·undo·redo·재적용에서 오른다. 취소·시작·갱신·할 일 없는 undo/redo 는 올리지 않는다(취소 뒤 같은 문단 id 가 유효하게 남음).
- `activeEditIds` = `base` + `undo` 의 편집 id. 커밋은 `redo` 를 버린다. `edits`·`canUndo`·`canRedo` 도 이 상태에서 계산한다.
- 문서당 초안 1개. 초안 중에는 `getPageEditability`·`planParagraphEdit`·`beginParagraphEdit`·`undo`·`redo`·`replayEdits`·`planSave`·`save` 가 `EditStateError`. `renderPage`·`extractPage`·`searchText`·`getPageEdits`·`getEditHistory` 는 허용하고 작업 문서(초안 상태)를 본다.
- 오류 이름은 Comlink 를 건너도 `name` 이 유지된다(`EditStateError`, `StaleRevisionError`). 뷰어는 `instanceof` 가 아니라 `name` 으로 구분한다. 메시지에 "미구현"을 쓰지 않는다(뷰어 `failure.ts` 가 기능을 끄는 신호).

### 3.3 RPC 별 저널 동작

| RPC | 저널 | 캐시·목록 |
| --- | --- | --- |
| `getPageEditability`·`planParagraphEdit` | 버리는 작업으로 감싼다(`probe`). 판정이 폴백 폰트를 넣는 등 문서를 바꿔도 `abandonOperation` 으로 되돌린다 | 변경 없음 |
| `beginParagraphEdit` | revision 확인 → 판정(probe) → `beginOperation('paragraph-edit')` → `prepareParagraphEdit` → 폰트 배정·리플로우·`writeEditBlock` → 첫 미리보기 렌더. 실패하면 `abandonOperation` | 쪽·±2쪽 캐시 무효화, 블록 목록 재구성 |
| `updateParagraphDraft` | 열린 작업 안에서 같은 순서로 다시 쓴다. 실패해도 초안은 유지 | 쪽 캐시 무효화 |
| `commitParagraphEdit` | 같은 작업 안에서 `recordEditMetadata` → `endOperation`. 로그에 `EditOp` 추가, `redo` 비움 | 쪽·±2쪽 캐시 무효화, 블록 목록 재구성 |
| `cancelParagraphEdit` | `abandonOperation` | 쪽 캐시 무효화, 블록 목록 재구성 |
| `undo`·`redo` | `doc.undo()`·`doc.redo()` | 영향 쪽 캐시 무효화, 블록 목록 재구성 |
| `replayEdits` | 저널 끈 채 적용 → `enableJournal()` | 쪽마다 무효화 |
| 저장 | `beginOperation('save')` → (폴백 사용 시) 서브셋 교체 → 저장 → `abandonOperation` (3.5) | 변경 없음 |

변경 영역 렌더(`DraftUpdate.region`): 갱신 때는 직전·새 `contentBox` 의 합집합 + 2 pt, 시작 때는 원 문단 bbox ∪ 배치 상자 + 2 pt. 배율은 갱신이 `DraftInput.renderScale`, 시작이 마지막 쪽 전체 렌더 배율(없으면 2)이다(5절 3번).

### 3.4 어댑터 인터페이스

core 가 pdf-ops·reflow 를 부르는 곳은 `EditAdapter` 하나다. 시그니처는 계약 커밋 그대로(`typeof` 로 묶음).

| 어댑터 멤버 | 실제 연결 | core 가 부르는 곳 | 가짜 어댑터 구현 |
| --- | --- | --- | --- |
| `createFonts(doc, loadFallback)` | `new FontManager(doc, loader)` | 첫 편집 계열 호출 | `FontManager` 하위 클래스. 한글(U+AC00–D7A3)은 폴백(계약 D4 수명 규칙 흉내), U+2603 은 `glyph-missing`, 그 밖은 원본 F1. `finalizeForSave` 는 `subsetFontBytes` 로 FontFile2 교체 |
| `planPageEditability` | pdf-ops | `getPageEditability`(probe) | 문단별 편집 가능 여부(표·도형 `not-flow-paragraph`, 텍스트에 `LOCKED` 포함 `remove-skipped`) |
| `planParagraphEdit` | pdf-ops | `planParagraphEdit`·`beginParagraphEdit`·재적용 | 문단 텍스트·첫 글자 모양·영역을 계획으로. 이전 편집 블록 위 문단이면 `editedBlock` |
| `prepareParagraphEdit` | pdf-ops | 초안 시작·재적용 | SourceMap 연산 범위로 쪽 콘텐츠에서 문단 text-show 를 잘라 내고 BT 앞에 `q /EBn Do Q`, 빈 Form(`/PdfEditorEdit`)을 쪽 Resources 에 등록. 재편집이면 제거 없이 기존 블록 |
| `layoutParagraph` | reflow | 시작·갱신·재적용 | 고정 폭 줄 나눔, `expand`·`shrink`·`keep` 처리 |
| `writeEditBlock` | pdf-ops | 시작·갱신·재적용 | 폰트별로 묶어 `Tm`+`Tj`, 블록 Resources 에 F1·폴백 폰트, `/PdfEditorFormat` |
| `listEditBlocks` | pdf-ops | 커밋·취소·undo·redo·재적용 뒤, 쪽 처음 쓸 때 | Resources/XObject 에서 `/PdfEditorEdit` 스트림 |
| `recordEditMetadata` | pdf-ops | 커밋 작업 안(활성 편집 + 이번 편집), 재적용 끝(저널 끈 채) | Info `/PdfEditorEdits` |
| `blockBounds` | core 기본 구현 | `getPageEdits`(로그에 없는 블록) | Form `/BBox` 를 쪽 변환으로 옮김 |

`blockBounds` 는 pdf-ops 시그니처가 아니라 core 가 정한 어댑터 멤버다. 기본 구현이 pdf-ops 호출 없이 `/BBox`(계약 D3: 사용자 공간으로 옮긴 `areaLimit`)를 쓰므로 새 파일에서 다시 연 편집 블록의 `contentBox`·`area` 는 `areaLimit` 근사다. 정확한 값이 필요하면 통합 때 pdf-ops 에서 받는다(4절).

### 3.5 D9 저장

```
commit:   (초안 작업 안) recordEditMetadata(활성 편집 + 이번 편집) → endOperation
planSave: changes ∪= 로그 변경 종류, edits = 편집 요약
save:     [journalOn] beginOperation('save')
          [폴백을 쓴 활성 편집 있음] FontManager.finalizeForSave
          saveToBuffer(options)
          abandonOperation
```

- 변경 종류: 활성 편집이 있으면 `content-stream`, 그중 폰트 폴백 경고가 있으면 `font-embed` 를 더한다. undo 한 편집은 빠진다.
- `SavePlan.edits` = `{ pages(활성 편집 쪽, 0부터), structureUnlinked(경고 tagged-structure-unlinked 편집 수), pdfaDeclared(/Metadata XMP 에 pdfaid) }`. 활성 편집이 없으면 null.
- `recordEditMetadata` 인자: `pages` 0부터 쪽 인덱스(활성 편집 전체), `structureNotUpdated` = 활성 편집 중 `tagged-structure-kept`·`tagged-structure-unlinked` 경고가 있음. 편집이 undo 되면 Info 도 되돌아가 저장 파일에는 활성 편집 쪽만 남는다.
- 전체 저장 승격: `decideSaveMethod` 가 증분이어도 ① 세션에서 전체 저장을 한 번 했거나(A3-9) ② 편집이 한 번이라도 커밋·재적용됐으면(undo 로 되돌렸어도) 전체 저장(`FULL_SAVE_OPTIONS`)으로 올린다. 판정만 하거나 초안을 취소한 문서는 문서가 바뀌지 않으므로 증분 저장을 그대로 쓴다(시험으로 고정). ②는 계약 D9 문장에 없는 core 의 해석이다(증분 구간에 되돌린 객체의 흔적이 남을 수 있음).
- 저널이 꺼진 문서(편집 RPC 미사용)는 감싸지 않는다. 저장 중 예외는 작업을 버리고 다시 던진다.
- 폴백을 쓴 활성 편집이 있고 redo 가 가능한 상태(undo 직후)에서 저장하면 서브셋 교체가 redo 단계를 버린다(2.4). 그 밖의 저장은 redo 를 보존한다.

### 3.6 재적용 (D6)

- `replayEdits(ops)` 는 편집 RPC 를 한 번도 부르지 않은 새 문서에서만 허용한다(저널을 끌 수 없으므로 저널이 이미 켜졌으면 `EditStateError`).
- 순서: 폴백 로드 → Info 보장 → 연산마다 [쪽 상태 → 대상 문단 찾기(쪽 PageModel 의 `glyphSeq` 목록이 `target.glyphSeqs` 와 같은 문단) → 판정 → `prepareParagraphEdit(op.id)` → 폰트 배정·리플로우·`writeEditBlock`(op 의 `runs`·`format`) → 캐시 무효화] → `recordEditMetadata`(전체 한 번) → `enableJournal()`.
- 재적용한 편집은 `base` 에 들어가 `activeEditIds` 에 나오고 undo 할 수 없다(`canUndo` false). 이후 새 편집은 평소처럼 undo 된다.
- 실패하면(대상 문단 없음·편집 불가·어댑터 예외) 실패 위치를 `재적용 실패(k/n번째, 편집 id)` 로 알리고, 문서가 일부만 바뀌었으므로 그 세션의 편집 RPC 를 모두 막는다(문서를 다시 열어야 한다).
- 결정성 틀: `edit-save-replay.test.ts` 의 `snapshot()` 이 쪽 콘텐츠 스트림·편집 블록 스트림 바이트·글자를 모아, 원래 편집 결과 = 재적용 결과 = 두 번째 재적용 결과를 비교한다(가짜 어댑터 기준 통과). 통합 때 같은 틀에 실제 어댑터를 꽂는다.

### 3.7 폴백 폰트 로더

- `loadFallbackFont` 는 `getPageEditability`·`planParagraphEdit`·`beginParagraphEdit`·`replayEdits` 시작에서 await 한다. 동시 호출은 같은 약속을 공유하고 실패는 캐시하지 않는다(다음 호출이 다시 시도).
- FontManager 에 넘기는 동기 로더는 로드된 바이트를 salt 사본으로 돌려준다(2.2). 로더가 없으면 폴백이 필요한 시점에 `EditStateError`.

### 3.8 계약에 없는 core 의 판단

| 항목 | 내용 |
| --- | --- |
| 판정 호출 감싸기 | 판정(`getPageEditability`·`planParagraphEdit`)은 문서를 바꾸지 않아야 하지만 FontManager 가 판정 중 폴백을 넣을 수 있다. 저널이 켜진 문서의 작업 밖 변경은 예외이므로 버리는 작업 안에서 부른다 |
| 저널 켜는 시점 | 첫 편집 계열 호출(판정 포함). `beginOperation` 이 있어야 판정을 감쌀 수 있기 때문. 편집 안 한 문서의 저장은 영향 없음(3.5) |
| 경고 `overflow-clipped` | 배치 상자가 `areaLimit` 밖으로 0.5 pt 넘게 나가면 넘친 띠를 `rects` 로. 선택(`keep`·`shrink` 최소·`expand` 상한)과 무관 |
| 경고 `area-overlaps-content` | 쓴 영역(`ReflowSummary.area`)이 다른 문단·표·도형과 겹치면 겹친 교집합을 `rects` 로. 원 문단 bbox 를 덮는 표·도형(쪽 배경 그림)은 제외. 레이아웃 기반 근사 |
| 경고 합성 | `font-fallback`·`glyph-missing`·`synthetic-style` 은 FontManager 의 현재 결과로, `overflow-clipped`·`area-overlaps-content` 는 core 판정으로 바꾸고 나머지(링크·태그·ActualText 등)는 계획 단계 경고를 유지. 같은 종류는 하나로 합친다 |
| 편집 id | 로그 `EditOp.id` 는 `prepared.editId`(없거나 이미 쓴 id 면 core 가 만든 id). 재편집에서 블록의 옛 id 와 겹치지 않게 한다 |
| 초안 중 `getPageEdits` | 작업 문서 기준이라 초안 블록을 포함한다 |

## 4. 통합 때 할 일

1. S1·S2 병합 뒤 `defaultEditAdapter` 로 `edit-engine.test.ts`·`edit-save-replay.test.ts` 의 흐름을 다시 돌린다(가짜 어댑터 의존 단언은 글자 `LOCKED`·`☃`·한글=폴백 규칙뿐). 어댑터 독립 단언(저널·로그·revision·캐시)은 그대로 유효해야 한다.
2. **S1 FontManager 의 폴백 재추가가 2.2 의 요구를 지키는지 확인**: `loadFallback()` 을 임베딩마다 호출, 바이트·`Font` 비캐시. 지키지 않으면 `save-replay` 의 "폴백 폰트 수명" 3건을 실제 FontManager 로 돌렸을 때 실패한다.
3. 판정 호출(`planPageEditability`·`planParagraphEdit`)이 문서를 바꾸는지 확인한다. 바꾼다면 core 의 probe 가 가리고 있다. 바꾸지 않는다면 probe 의 비용(작업 열고 닫기)을 줄일지 판단한다.
4. `recordEditMetadata({ pages })` 를 S1 과 맞춘다: 기준(core 는 0부터 쪽 인덱스, 활성 편집 전체를 넘긴다. 계약 5.6 문자열은 1부터), **커밋마다 반복 호출**되므로 같은 입력에 멱등이어야 한다는 점, Info 사전이 이미 있다는 가정, `getTrailer()` 를 객체 추가 뒤에 부르는 순서(2.3), 이미 있는 `/PdfEditorEdits` 값(이전 세션 기록)과 합집합을 만드는 방식. 합집합 때문에 undo 로 편집을 되돌려도 이전 세션의 쪽 번호는 남는다.
5. V1 후반: 실제 코퍼스 편집 열에서 원래 편집 결과와 `replayEdits` 결과를 비교한다(`snapshot` 틀). 재적용 시간을 재서 D6 체크포인트 간격이 필요한지 정한다.
6. 판정 시간(5.1: 문단 10 ms, 쪽 100 ms)과 편집 반응 시간(8.4)에서 core 구간(`updateMs`, 영역 렌더 포함)을 분리해 기록한다. 렌더 구간은 2.6 참고.
7. `beginParagraphEdit` 첫 미리보기 배율(5절 3번), `blockBounds` 근사(3.4), 전체 삭제된 블록의 재편집·재적용(5절 8번)을 S1·S4 와 정한다.
8. 저널 단계 수 상한(2.5)을 사용자와 정한다. 상한이 필요하면 `edits` 가 N 을 넘을 때 뷰어가 저장·재열기를 권고하거나, 오래된 단계는 `base` 로 접는 방식(문서를 재구성)을 검토한다.
9. S4: Worker 에서 `loadFallbackFont` 연결(`exposePdfWorker` 두 번째 인자), 복구 때 `open` 직후 `replayEdits` 호출(편집 RPC 보다 먼저), 오류 `name` 으로 `StaleRevisionError`·`EditStateError` 구분, `RenderedPage.clip` 은 부동소수라 `clip × scale` 을 반올림해 캔버스에 놓는다.

## 5. 계약 불일치·해석 차이

| # | 항목 | 내용 | 처리·제안 |
| --- | --- | --- | --- |
| 1 | D4 폴백 수명 | `addFont` 가 되돌린 폰트의 끊긴 참조를 돌려준다(2.2) | core 로더 salt 로 우회. S1 요구 2건. **계약 D4 문장 수정 제안**: "폴백 폰트를 다시 넣을 때는 폰트 바이트가 이전과 달라야 한다(MuPDF 폰트 리소스 표). FontManager 는 임베딩마다 다른 바이트로 넣는다" |
| 2 | D9 Info 생성 | 첫 편집 작업 안에서 만든 Info 는 취소·undo 때 끊긴 참조(2.3) | 저널 켜기 직전(작업 밖)에 만든다. **계약 D9 수정 제안**: "Info 사전이 없으면 저널을 켜기 직전에 만든다" |
| 2a | D9 Info 기록 위치 | 저장 작업 안에서 Info 를 기록하면 undo 직후 저장이 redo 를 잃는다(2.4) | **커밋 작업 안에서 기록**한다(저널에 남아 undo·redo 와 함께 움직임). **계약 D9·5.6 수정 제안**: 저장 순서는 `beginOperation('save')` → (폴백 사용 시) 서브셋 교체 → `saveToBuffer` → `abandonOperation`, Info `/PdfEditorEdits` 는 편집을 커밋할 때 기록 |
| 2b | 초안 취소·판정과 redo | 작업 안 첫 변경이 redo 를 버린다. 초안을 시작하면 redo 가 사라지고 취소해도 돌아오지 않는다(2.4) | core 가 redo 스택을 저널에 맞춘다. 뷰어는 초안 시작 시 `canRedo` 가 false 가 됨을 알아야 한다. 계약 D6 에 문장 추가 제안 |
| 3 | 4절 `beginParagraphEdit` | 시그니처에 렌더 배율이 없는데 반환(`first.region`)은 렌더 결과다 | 마지막 쪽 전체 렌더 배율(없으면 2)을 쓴다. 제안: 선택 인자 `renderScale` 추가(shared-types 변경이라 메인 세션 결정). 뷰어가 다른 배율이 필요하면 바로 `updateParagraphDraft` 를 한 번 더 부르면 된다 |
| 4 | 5.1 경고 `overflow-clipped`·`area-overlaps-content` | 계산 주체가 계약에 없다 | core 가 `ReflowSummary` 와 쪽 레이아웃으로 계산(3.8). pdf-ops 가 같은 종류를 내면 종류별로 합쳐지므로 중복 없음 |
| 5 | D9 "편집이 있는 저장은 항상 전체 저장" | 편집을 되돌린 문서의 증분 저장 가부가 불명확 | 커밋·재적용 이력이 있으면 되돌렸어도 전체 저장으로 승격(3.5) |
| 6 | 5.7 초안 중 "다른 편집 RPC 는 예외" | 대상 범위가 불명확 | 판정 2개·시작·undo·redo·재적용·판정 저장 둘은 예외, `getPageEdits`·`getEditHistory` 는 허용(3.2) |
| 7 | `ParagraphTarget.glyphSeqs` | 글자를 전부 지운 편집 블록은 글리프가 없어 레이아웃 문단이 아니다. 재편집·재적용 대상으로 가리킬 수 없다 | 재적용은 `대상 문단을 찾지 못함` 으로 실패한다. 빈 블록 재편집 경로(`editedBlock` 로만 가리키기 등)를 S1·메인 세션이 정한다 |
| 8 | `EditOp.id` 와 재편집 | 재편집에서 `/PdfEditorEdit` 가 옛 id 로 남으면 로그 id 가 겹친다 | core 는 겹치지 않는 id 를 쓴다(3.8). S1 이 재편집 때 블록 id 를 새 id 로 바꾸는지 확인 |
| 9 | `DraftInput.composition` | core 는 사용하지 않는다(조합 밑줄·캐럿은 뷰어가 리플로우 결과로 그림) | 변경 없음 |

## 6. 시험

| 파일 | 건수 | 내용 |
| --- | --- | --- |
| `test/render-clip.test.ts` | 8(매개변수 포함) | 영역 = 쪽 전체의 같은 위치 픽셀(회전·배율), 격자 정렬, 쪽 경계 자르기, RangeError |
| `test/journal-v1.test.ts` | 13 | V1 전반(MuPDF 직접): 블록·콘텐츠·리소스·폰트 undo/redo, 폰트 표 끊긴 참조, Info, trailer 함정, redo 단계 보존 3건, 계약 시나리오 3건, 감싸지 않은 저장 |
| `test/edit-engine.test.ts` | 26 | 판정·초안·커밋·취소·undo/redo·재편집·상태 규칙·실패 복구·캐시 무효화·경고·저장 방식·수명 |
| `test/edit-save-replay.test.ts` | 22 | 폴백 수명 4, D9 저장 7, redo 보존 4, 재적용 6, 재열기 1 |
| `test/edit-walk.test.ts` | 6(시드) | 임의 순서(커밋·취소·undo·redo·저장) 40단계, 매 단계 저널 위치·단계 수 = 로그, 글자 = 모델 |
| `test/edit-util.test.ts` | 6 | 사각형·경고 판정·경고 합성 |

가짜 어댑터 기반 시험은 core 의 저널·로그·캐시·저장 로직을 검증하고, pdf-ops·reflow 의 정확성은 검증하지 않는다.
