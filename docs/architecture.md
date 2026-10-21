# 아키텍처

## 패키지

| 패키지 | 책임 | 주요 의존 |
| --- | --- | --- |
| `packages/shared-types` | `PageModel`·`SourceMap`·`EditOp`·`EditPlan`·Worker RPC 타입. 병렬 구현 전에 고정하는 계약 | 없음 |
| `packages/pdf-ops` | 콘텐츠 스트림 인터프리터(SourceMap 생성), 텍스트 제거·삽입, 편집 블록(Form) 쓰기, 패스 편집, 폰트 임베딩·서브셋, 저장 방식 결정(`save-method.ts`) | `mupdf`, `shared-types` |
| `packages/reflow` | 셰이핑(원본 폰트 명세 폭, 폴백 폰트 harfbuzz)과 줄·글리프 배치. 직렬화는 하지 않음 | `shared-types` |
| `packages/layout-recon` | `PageModel` → 문단·열·표·도형·읽기 순서(`DocumentModel`) | `shared-types` |
| `packages/core` | MuPDF 객체 수명, 문서 상태, 편집 엔진(판정·시작·갱신·커밋, 저널 undo/redo), 저장, Worker RPC(Comlink) | `pdf-ops`, `reflow`, `layout-recon` |
| `packages/viewer-ui` | Preact 뷰어: 쪽 렌더, 텍스트 선택 층, 검색, 편집기, 패스 편집, 편집 가능 표시, 로그·복구 | `shared-types` (Worker 호스트 인터페이스로만 core 와 연결) |
| `apps/extension` | MV3 셸: manifest, 서비스 워커, 뷰어 페이지, 뷰어 소유 module Worker, 저장 어댑터(FSA·downloads), 복구 | 위 전부 |
| `tools/spike-m0` | M0 기술 검증 스파이크 | — |

## 데이터 흐름

```
원본 바이트 (MIME handler 의 streamUrl 을 한 번 읽음)
  → Worker: core.open (Stream 입력) → core.extractPage (PageModel)
  → pdf-ops.interpret (SourceMap)  ·  layout-recon (DocumentModel)
  → 뷰어: 렌더 캔버스 + 선택 층 + 편집 오버레이
  → 사용자 편집 (문단·셀·패스)
  → core.planParagraphEdit / planPathEdit (편집 가능 판정)
  → begin → update(초안 영역 렌더) → commit  (저널 작업 하나 = 편집 하나)
       문단: pdf-ops.prepare(제거 + 편집 블록 Form 호출) → FontManager → reflow → pdf-ops.write
       패스: pdf-ops.path-edit (연산자 바이트 교체)
  → undo/redo: MuPDF 저널
  → core.planSave → 뷰어 확인 → core.save(저장 작업으로 감싼 전체 저장)
  → 저장 어댑터: showSaveFilePicker (불가 시 chrome.downloads)
```

원칙:

- 원본 바이트 + 커밋된 편집 로그(EditOp)가 진실 원천입니다. Worker 가 죽으면 원본을 다시 열고 로그를 재적용해 복구합니다.
- MuPDF 와 문서 상태는 뷰어 소유 Worker 에만 있습니다. 서비스 워커는 폴백 가로채기와 전역 이벤트만 합니다.
- 편집이 있는 저장은 항상 전체 저장입니다. 폴백 폰트만 서브셋합니다.

## 가로채기 경로

| 경로 | Chrome | 구성 |
| --- | --- | --- |
| MIME handler | 151 이상 | `mime_types_handler` → 뷰어 → `chrome.mimeHandler.getStreamInfo()` |
| DNR 폴백(개발·레거시 빌드) | 128–150 | `declarativeNetRequest` 응답 헤더 조건 → `viewer.html?file=<원 URL>` |

## 계약·작업 문서 색인

| 단계 | 계약 | 작업·통합 기록 |
| --- | --- | --- |
| M0 기술 검증 | — | `docs/m0-day1-log.md`, `docs/m0-dod-xobject-redact-save.md`, `docs/m0-corpus-recheck.md`, `docs/m0-closeout.md` |
| M1 추출·원본 연결 | `docs/m1-contract.md` | `docs/m1-core.md`, `docs/m1-pdf-ops.md`, `docs/m1-viewer-ui.md`, `docs/m1-integration.md`, `docs/m1-decisions.md` |
| M2 레이아웃 복원 | `docs/m2-contract.md` | `docs/m2-accuracy.md`, `docs/m2-labeling-guide.md` |
| M3 텍스트 재작성 | `docs/m3-contract.md` | `docs/m3-core.md`, `docs/m3-pdf-ops.md`, `docs/m3-reflow.md`, `docs/m3-viewer-ui.md`, `docs/m3-integration.md` |
| M4 표 셀·벡터 편집 | `docs/m4-contract.md` | `docs/m4-core.md`, `docs/m4-pdf-ops.md`, `docs/m4-viewer-ui.md`, `docs/m4-integration.md` |
| M5 안정화·배포 | `docs/m5-contract.md` | 작업별 `docs/m5-heap.md`·`docs/m5-perf.md`·`docs/m5-release.md`(작성 예정, 담당 작업 완료 시) |
| 계획 | `PLAN.md` | — |
| 사용자·등록 자료 | — | `docs/user/`, `docs/store/`, `docs/release.md` |
| 업스트림 | — | `docs/upstream/` (MuPDF 1.28.1 `resolve` + compact 결함 보고) |
