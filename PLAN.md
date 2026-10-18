# PDF 편집기(Chrome 확장) 개발 계획

## 0. 문서 상태

| 항목 | 내용 |
|---|---|
| 버전 | v2.1 (v2 = 1차 안 리뷰 반영: 저장 정책 충돌, 폰트 임베딩 오해, 원본 연결 계층 누락, 지원 범위 불명확, M0 검증 순서, Chrome API 정정, 테스트 기준, 모델 배정, ML/태그 범위, 작성·검증 방식) |
| 작성일 | 2026-10-18 |
| 작성 환경 | Mustree 서버(호스트명 `sailab01`) `/mnt/nas4/kjune/pdf-editor`, Claude Code 세션에서 작성. Windows PC(`C:\Users\harry\pdf-editor\PLAN.md`)에는 scp 복사본만 둔다 |
| 리서치 근거 | MuPDF 1.28.x 공식 JavaScript/WASM 레퍼런스, Chrome 확장(MV3) 공식 문서, Claude Code 공식 문서 |
| 수치 표기 규칙 | 용량·버전은 "원본 / 압축 / 배포 번들" 기준과 측정 버전을 함께 적는다. 실측 전 값은 **문서 기준** 으로 표시하고, 실측 값에는 **실측 YYYY-MM-DD** 를 붙인다 |
| 상태 | 계획 문서. M0 Day 1(12절) 완료(2026-10-18, 커밋 5개). 결과·Action Items 는 `docs/m0-day1-log.md` |
| 변경 이력 | 2026-10-18 v2.1: 2절 "한글 폴백 폰트" 를 M0 Day 1 실측(P1: CFF OTF 실패 → glyf TTF 서브셋)으로 갱신. 그 외 절은 v2 와 동일 |

확정된 결정
- 주력 형태: Chrome 확장 우선. 코어는 TypeScript + MuPDF WebAssembly(npm `mupdf`). 데스크톱(Tauri)은 후속.
- 라이선스: 오픈소스(AGPL-3.0). MuPDF WASM 그대로 사용.
- 위치: SSH 연결 `Mustree` 의 `/mnt/nas4/kjune/pdf-editor`. 확장 테스트는 Windows PC 의 Chrome.
- "모델" = 개발용 Claude 모델 배정과 백그라운드 에이전트/세션 사용 규칙(10절).
- 일정: **20주는 "지원 대상을 한정한 MVP" 목표치이며, M0 기술 검증 후 재산정** 한다.

---

## 1. 목표와 지원 범위

### 1.1 제품 목표
- Chrome 에서 PDF 를 열면 즉시 편집 모드로 진입한다.
- **"모든 PDF 가 편집 모드로 열린다"** 와 **"모든 객체를 수정할 수 있다"** 는 구분한다.
- 문서·객체 단위로 **편집 가능 판정(editability)** 을 내리고, 불가 사유를 UI 에 표시한다.
  예: 스캔 PDF 이미지 속 글자, 공유 Form XObject, 복잡 클립/투명도, 문자 매핑 복원 불가 폰트.

### 1.2 비범위(v1)
- 래스터 이미지 내부 편집(교체만 지원), OCR
- 폼/서명, 협업
- 차트 데이터·축·범례 연동 수정
- 표 행·열 추가/병합/분할
- 문단 간·페이지 간 밀어내기

### 1.3 v1 지원 범위 정의

| 기능 | v1 정의 | 후속 |
|---|---|---|
| 문단 리플로우 | 선택 문단의 지정 영역(원본 bbox, 사용자가 핸들로 조정 가능) 안에서만 재배치 | 다음 문단 밀어내기, 페이지 넘김, 페이지 생성 |
| 영역 초과 | **자동 클립 금지.** 초과 상태를 표시하고 사용자가 (a) 영역 확장 (b) 글자 크기 축소(최소 크기 설정, 기본 원본의 80%) (c) 그대로 두기 중 선택 | 자동 재배치 |
| 표 편집 | 기존 셀의 텍스트 수정. 초과 시 위와 같은 선택 UI | 행·열 추가, 병합·분할 |
| 벡터 편집 | 편집 가능 판정을 통과한 패스의 좌표·선 두께·선/채움 색 수정 | 차트 의미 단위 편집 |
| 공유 객체·클립·투명도 | 지원 조건 통과 객체만 편집. Form XObject 는 "선택 위치만 복제 후 수정" 또는 v1 편집 제한 중 M0 결과로 확정 | 전체 지원 |
| 태그(구조) PDF | 아래 1.4 "태그 정책" 참조 | |

### 1.4 태그 정책(v1 에서 확정할 세 가지)
1. 기존 태그 PDF 편집 지원 여부: 기본 "지원하되 편집 영역의 구조 갱신은 보장하지 않음" 을 UI 에 명시 표시한다.
2. 편집 영역의 읽기 순서·구조 연결 갱신 여부: v1 에서는 갱신하지 않고, 변경 사실을 문서 메타에 기록한다.
3. 보존 불가 시 처리: 저장 전 경고 + 편집 제한 옵션.

태그 정책은 M5 의 작은 작업이 아니라 **M3 설계 항목** 으로 둔다.

---

## 2. 기술 결정

| 항목 | 결정 | 근거/조건 |
|---|---|---|
| 언어/런타임 | TypeScript, ESM, Node 22+ | 확장 내부 Python 불가. 단일 코어로 확장/데스크톱 공유 |
| PDF 엔진 | `mupdf` npm. 개발 시작 시 정확한 패치 버전으로 lockfile 고정. npm 최신 **1.28.1 (실측 2026-10-18)**. wasm 약 10.4MB 원본 / 3.6MB brotli (문서 기준) | 글리프·폰트·벡터 추출, redaction, 폰트 임베드, 스트림 읽기/쓰기 제공. `mupdfjs` 래퍼는 폐기됨 → 코어 API 만 사용 |
| 셰이핑 | 1차 `Font.advanceGlyph`, M3 에서 `harfbuzzjs`(MIT, 약 0.4MB wasm, 문서 기준) | 라틴 커닝/리거처. 한글 완성형은 단순 배치 가능 |
| 한글 폴백 폰트 | Noto Sans KR **glyf(TrueType) 서브셋 TTF** 번들, **2,556,960 B (실측 2026-10-18, 원본 기준, brotli 미측정)**. Google Fonts 가변 TTF → `wght=400` 정적 인스턴스 → 한글 음절 11,172자·호환 자모·라틴·기본 기호 서브셋(12,267 글리프). 위치 `assets/fonts/`, 생성 스크립트 `scripts/fonts/build-noto-sans-kr-subset.sh`(재생성 해시 동일) | 실제 임베딩은 FontManager 가 수행(3.3절). **P1(M0 Day 1, 2026-10-18): CFF 기반 OTF 사용 금지.** 같은 `new Font` + `addFont` 절차에서 CFF OTF(notofonts SubsetOTF/KR)는 MuPDF 1.28.1 이 2바이트 코드를 glyph id 가 아닌 CID 로 재매핑해 한글 대부분이 미표시 또는 다른 글리프로 렌더(`FT_Load_Glyph invalid argument` 250건)되고 `subsetFonts()` 도 적용되지 않았다(`Index bounds` 오류, FontFile3 4.6MB 그대로). glyf TTF 서브셋은 표시·서브셋·검색·복사 모두 통과. 근거 `docs/m0-day1-log.md` 6.2~6.3, 대조 테스트 `tools/spike-m0/test/spike.test.ts` |
| 레이아웃 복원 | MuPDF stext 옵션(`segment`, `paragraph-break`, `table-hunt`, `structured`) 출력을 **자체 복원 로직의 입력** 으로 사용 | 옵션만으로 완성된 셀/병합 구조가 나온다고 전제하지 않음 |
| ML | 선택 기능. 표·문단 후보 영역 탐지 보조. **채택 모델·체크포인트·라이선스·ONNX 변환물·입출력 스키마·다운로드 크기는 코퍼스 평가 후 확정** | 추론 런타임(onnxruntime-web)은 확장에 번들. 원격 다운로드는 모델 데이터만(Web Store 원격 코드 금지) |
| UI | Preact + Canvas 오버레이 | |
| 모노레포 | pnpm workspaces + turbo, Vitest, Playwright, ESLint/Prettier | |
| 배포 | GitHub(AGPL-3.0) + Chrome Web Store | |

---

## 3. 편집 엔진 설계

### 3.1 저장 정책
- `applyRedactions()` 적용 문서는 `canBeSavedIncrementally()` 가 false 가 되므로 **전체 저장(full save)이 기본 경로** 다.
- 규칙: 저장 방식은 변경 유형과 `canBeSavedIncrementally()` 결과로 결정한다. 증분 저장은 적용 가능한 변경(주석·메타 등 redaction 없는 변경)에 한정한다.
- 전체 저장의 **최대 메모리·저장 시간을 M0 부터 벤치마크** 한다(기준 문서·PC 조건 명시). WASM 배포 파일 크기는 실행 메모리 예산으로 쓰지 않는다.
- redaction 은 "선택 글자만 지우는 함수" 가 아니다. `applyRedactions(blackBoxes=false, imageMethod, lineArtMethod, textMethod)` 의 이미지·선화·텍스트 옵션을 **텍스트 교체 용도로 명시 지정** 한다(기본: 텍스트 제거, 선화·이미지 보존).
- 페이지에 기존 Redact 주석이 있는 문서는 사전 감지해 구분 처리한다(사용자 경고 또는 임시 분리).

### 3.2 undo/redo
- 모델: **원본 바이트 + 편집 로그(EditOp 리스트) 를 진실 원천** 으로 유지한다. 작업용 문서는 "원본 + 로그 재적용" 으로 재구성 가능해야 한다.
- 성능: N 단계마다 체크포인트(작업용 문서 스냅샷 바이트)를 저장하고, undo 는 가장 가까운 체크포인트에서 재적용한다. N 과 메모리 상한은 M0 벤치마크로 결정한다.
- 엔진 자체 변경 기록 기능은 M0 에서 검증 후 보조로만 채택한다.

### 3.3 FontManager
"동일 폰트로 리플로우" 의 정확한 정의: 원본 폰트의 재사용 가능 여부와 문자 커버리지를 확인한 뒤 우선 재사용한다. 재사용이 어려우면 지정 폴백 폰트를 **실제로 임베딩** 하고, 해당 편집 영역의 폰트 변경을 UI 에 표시한다.

| 상황 | 처리 |
|---|---|
| 원본 폰트 재사용 가능 + 새 글자 표현 가능(`encodeCharacter(cp) !== 0`) | 원본 폰트 리소스 재사용 |
| 원본이 서브셋이라 새 글자 없음 | 폴백 폰트 선택 → `new Font(name, bytes)` → `doc.addFont(font)`(Identity-H CID) 로 **폰트 바이트 포함 임베딩** → 저장 시 `subsetFonts()` |
| 원본 폰트의 문자 매핑(CMap/Encoding) 복원 곤란 | 편집 가능 판정 "제한" + 폴백 사용 시 표시 |
| 저장 후 다른 뷰어 | 모양뿐 아니라 **복사·검색·재추출(ToUnicode)** 검증 |

주의
- `addCJKFont` 는 **폰트를 포함하지 않는 UTF-16 CID 폰트 추가** 다. 한글 임베딩 경로로 쓰지 않는다. 폴백 폰트가 시스템에 있다는 가정도 하지 않는다.
- `addFont()` 만으로 모든 글리프 매핑·ToUnicode 가 해결된다고 전제하지 않는다. M0 에서 실제 폰트 바이트·글리프 매핑·ToUnicode 를 함께 검증한다.
- 한글 IME: 조합 중 편집 상태, 커서 위치, 조합 완료 시점의 리플로우, undo 단위를 M3 완료 기준에 포함한다.

### 3.4 계층 모델 (추출 ≠ 수정)
"어디에 무엇이 그려져 있는가"(추출)와 "원본에서 그 부분만 바꾸기"(수정)는 별도 계층이다. `StructuredTextWalker.onChar` 와 `Device` 콜백은 원본 스트림 위치를 주지 않으므로 **원본 연결 계층을 자체 구축** 한다.

| 계층 | 내용 |
|---|---|
| 추출 모델 `PageModel` | chars(글리프·유니코드·quad·폰트·크기·색), paths, images, 좌표·스타일 |
| 논리 문서 모델 `DocumentModel` | paragraphs, columns, tables/cells, figures, readingOrder, 스타일 구간 |
| 원본 연결 정보 `SourceMap` | 콘텐츠 스트림 참조(객체 번호, Contents 배열 인덱스), 연산자 바이트 범위, 그래픽/텍스트 상태(CTM, 폰트 리소스명, 클립 스택), Form XObject 사용 경로(중첩 포함) |
| 편집 계획 `EditPlan` | 교체 대상, 영향 받는 객체 목록, 폴백 여부, 편집 가능 여부와 제한 사유, 예상 저장 방식 |

- SourceMap 생성 방법: `pdf-ops` 의 콘텐츠 스트림 **인터프리터**(토크나이저 + 그래픽 상태 머신 + Form XObject 재귀)가 각 텍스트/패스 연산자의 바이트 범위와 상태를 기록하고, 좌표·폰트·글리프 ID 로 `PageModel` 의 chars/paths 와 매칭한다. 매칭 실패 객체는 편집 불가로 판정한다.
- MuPDF `PDFProcessor` / `PDFPage.process` 는 `mutool run` 전용이라 npm WASM 에서 쓸 수 없다 → 자체 구현 범위는 단순 토큰 분리보다 넓다.
- 공유 Form XObject: 여러 페이지/위치에서 재사용되면 원본 수정 시 선택하지 않은 위치까지 바뀐다. 정책은 "선택 사용 위치만 복제(새 XObject) 후 수정" 을 기본안으로 하고, M0 에서 검증 후 확정한다. 불가 시 v1 편집 제한.

---

## 4. 모듈 아키텍처

| 패키지 | 책임 |
|---|---|
| `packages/shared-types` | `PageModel`, `DocumentModel`, `SourceMap`, `EditOp`, `EditPlan`, Worker RPC 계약. **병렬 구현 전 커밋·고정** |
| `packages/core` | MuPDF 객체 수명, 문서 상태(원본 바이트·로그·체크포인트), Worker RPC(Comlink). `open`, `renderPage`, `extractPage`, `applyEditPlan`, `save` |
| `packages/pdf-ops` | 콘텐츠 스트림 인터프리터(SourceMap 생성), redaction 래퍼, 배치 결과 → PDF 연산자 직렬화, 원본 객체 반영(스트림 교체/추가, XObject 복제), 저장 방식 결정 |
| `packages/layout-recon` | `PageModel → DocumentModel`. MuPDF 플래그 + 열/표 휴리스틱(PyMuPDF `find_tables` lines/text 전략 포팅). ML 플러그인 슬롯 |
| `packages/reflow` | 텍스트 셰이핑(`advanceGlyph` → harfbuzz)과 줄·글리프 배치 결정(`layoutParagraph → Line[]/Glyph[]`). 직렬화는 하지 않음 |
| `packages/viewer-ui` | Preact 캔버스 + 오버레이 에디터(문단, 셀, 벡터 핸들), 초과 상태 UI, 편집 가능 표시, undo/redo UI |
| `apps/extension` | MV3 셸(manifest, mimeHandler, DNR 폴백, viewer.html, 저장 어댑터) |
| `apps/desktop`(후속) | 같은 코어를 Tauri 로 포장 |

데이터 흐름

```
원본 바이트
  → core.extract(PageModel) + pdf-ops.interpret(SourceMap)
  → layout-recon(DocumentModel)
  → 사용자 편집(EditOp)
  → pdf-ops.plan(EditPlan, 편집 가능 판정)
  → reflow(배치)
  → pdf-ops.apply(redaction + 새 스트림/XObject)
  → core.save(방식 결정 + 벤치마크 기록)
```

---

## 5. Chrome 확장 설계

### 5.1 가로채기(인터셉트)
- **v1 기준: Chrome 151+ 공개 MIME handler.** manifest `mime_types_handler: {"application/pdf": {handler_url, can_embed: true}}`.
- 조건: `getStreamInfo()` 는 MIME handler 문맥에서 호출한다. `streamUrl` 은 **한 번만 fetch** 하고 `originalUrl` 재요청은 금지한다. 전체 스트림 수신 후 지원 여부를 판정하고, 미지원이면 `abortAndFallbackToNativeHandler()` 를 호출한다. file:// 은 별도 파일 URL 설정이 불필요하다. POST 생성 PDF·일회성 URL 대응은 이 규칙으로 보장한다.
- 구버전 호환(별도 지원 범위, v1 보장 아님): `declarativeNetRequest` 응답 헤더 조건(`content-type: application/pdf`) 리다이렉트는 **Chrome 128–150 의 제한적 경로** 다. file:// 에 대한 DNR 동작은 "불가" 로 단정하지 않고 **M0 검증 항목** 으로 둔다(현 Chromium 은 파일 접근 권한 검사 방식). 128 미만은 미지원.

### 5.2 실행 위치·보안
- MuPDF 와 문서 상태는 **뷰어 소유 module Worker** 에서 관리한다. 확장 서비스 워커는 navigation 폴백과 전역 이벤트만 담당한다. SharedArrayBuffer 불필요(단일 스레드 빌드).
- CSP: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.

### 5.3 저장 요구사항
- MIME handler 로 바이트를 받았다고 쓰기 핸들이 생기지 않는다.
- **최초 저장 시 사용자가 저장 대상을 선택(FSA `showSaveFilePicker`)** → 쓰기 권한 확보 후 동일 핸들로 Ctrl+S 재저장.
- HTTP 로 연 PDF 는 사용자가 지정한 로컬 파일에 저장한다. FSA 불가 시 `chrome.downloads` 폴백.
- M0 에서 **일반 뷰어 페이지 / 최상위 MIME handler / 임베디드 MIME handler** 세 문맥을 나눠 FSA 가용성을 확인한다.

### 5.4 메모리
- 페이지 단위 지연 추출, 렌더 캐시 LRU, 전체 저장 시 피크 메모리 측정. WASM 힙 상한 2GiB.

---

## 6. 마일스톤 (총 20주 = MVP 목표치, M0 후 재산정)

| 단계 | 기간 | 완료 기준(DoD) |
|---|---|---|
| **M0 핵심 편집 가능성 검증** | 3주 | 모노레포 초기화 + 최소 확장 셸 + 아래 "M0 DoD" 전부 통과. 결과로 v1 범위·일정 재산정 문서 작성 |
| M1 추출·원본 연결 | 3주 | `PageModel` + `SourceMap` 생성, Form XObject 재귀, 매칭 실패율 측정. 디버그 오버레이. 코퍼스 회귀 테스트 |
| M2 레이아웃 복원 | 4주 | 문단/열/표 복원, 읽기 순서. **정답 라벨 기반 정확도** 하네스 |
| M3 텍스트 재작성 | 4주 | 문단 편집 → 리플로우(영역 내) → 초과 UI → 저장. 라틴 후 한글. harfbuzz. undo(체크포인트). **IME 조합 시나리오**. 태그 정책 구현 |
| M4 표/도표 편집 | 3주 | 셀 텍스트 수정(초과 선택 UI), 벡터 좌표·선·채움 편집, 편집 가능 판정 UI |
| M5 안정화/배포 | 3주 | 대용량 벤치마크 목표 달성, 폰트 서브셋, Web Store 패키징, 문서화 |

### M0 DoD
끝까지 한 번 통과해야 하는 흐름: 기존 PDF 열기 → 짧은 문단 교체 → 원본에 없던 한글 추가 → 배경·테두리 유지 → 저장 → 재열기 → 검색·복사 확인

| 검증 | 통과 기준 |
|---|---|
| 텍스트 교체 | 기존 문단 제거, 새 문단 중복 없이 표시 |
| 새 한글 입력 | 원본 서브셋에 없는 글자가 폴백 폰트 임베딩으로 저장 후 정상 표시 |
| 주변 보존 | 표 선·배경·인접 텍스트 변화 없음(redaction 옵션 검증) |
| 저장 후 재열기 | Chrome 과 다른 뷰어(예: pdf.js, Acrobat Reader) 정상 표시 |
| 텍스트 의미 보존 | 검색·복사·재추출 결과가 입력과 일치(ToUnicode) |
| 저장 방식 | redaction 후 `canBeSavedIncrementally()` 결과 확인, 전체 저장 피크 메모리·시간 측정 |
| 첫 저장·재저장 | 파일 선택 후 동일 대상에 Ctrl+S 재저장(세 문맥별 FSA 결과) |
| 공유 XObject | 복제 후 수정 정책 동작 여부 |
| 가로채기 | 151+ mimeHandler(최상위/임베디드/file://), 128–150 DNR(file:// 포함) 실측 |

---

## 7. 리스크와 대응

1. 리플로우 충실도(커닝/힌팅, Form XObject·클립·공유 스트림) → "편집 블록만 교체, 나머지 원본 유지" + 편집 가능 판정 + 시각/텍스트/객체 3축 검증.
2. 폰트 임베딩·매핑(서브셋, non-Identity CMap, ToUnicode) → FontManager 표(3.3절) + M0 검증.
3. 전체 저장 메모리/시간 → M0 벤치마크, 체크포인트 상한, 지연 로딩.
4. 레이아웃 휴리스틱 한계 → 정확도 하네스로 실패 유형 수집 후 ML 옵트인 판단.
5. Chrome 구버전 호환 → v1 범위 밖으로 관리, 안내 UI.
6. `mupdfjs` 폐기, `PDFProcessor` 불가 → pdf-ops 인터프리터 자체 구현(Opus 설계).

---

## 8. 테스트 계획

- 회귀 기준 vs 정확도 기준을 구분한다. 골든 JSON 은 회귀용이다. 정확도는 **원본을 확인한 독립 검토자가 승인한 정답 라벨**(문단 경계·셀·읽기 순서)로 측정한다. 생성 스크립트 출력은 검토 없이 정답으로 확정하지 않는다.

검증 축

| 축 | 내용 |
|---|---|
| 시각 | 편집 영역 밖 변화, 잘림, 중복, 배경·선 손상(픽셀 diff 는 이 축의 일부) |
| 텍스트 | 검색·복사·재추출, Unicode 매핑 |
| 객체 | 다른 페이지·공유 객체의 의도치 않은 변경(객체 diff) |
| 편집 동작 | undo/redo, 연속 수정, 저장 후 재편집, IME |
| 성능 | 첫 렌더, 편집 반응, 저장 시간, 피크 메모리. 벤치마크 문서 세트와 PC 조건을 먼저 정한 뒤 목표 수치 설정 |

- 코퍼스 `fixtures/`: 한글 논문, 영문 보고서, 다단 뉴스레터, 표 중심 재무 문서, 벡터 차트 문서, 태그 PDF, 공유 XObject 문서 각 2~3개 + 수백 페이지 벤치마크 1~2개.
- 자동화: 서버에서 Vitest(순수 로직) + **Playwright 번들 Chromium, persistent context, `channel: 'chromium'`** 으로 확장 로드. Windows 실제 Chrome 수동 검증과 구분해 기록한다.

---

## 9. 개발 워크플로우 (서버 + 로컬 Chrome)

- 코드/빌드/테스트: `Mustree:/mnt/nas4/kjune/pdf-editor`, `pnpm build` → `apps/extension/dist`.
- 동기화: `scp -r Mustree:/mnt/nas4/kjune/pdf-editor/apps/extension/dist C:\Users\harry\pdf-editor-dist` (또는 rsync/git).
- 로드: `chrome://extensions` 개발자 모드 → "압축해제된 확장 프로그램 로드".

---

## 10. Claude Code 모델 배정과 백그라운드 규칙

모델 ID: Opus 5.5 `claude-opus-5-5`, Sonnet 5.5 `claude-sonnet-5-5`, Haiku 5.5 `claude-haiku-5-5`, Fable 5.1 `claude-fable-5-1`.
Claude Code 버전 조건(공식 문서 기준): Opus 5.5 v2.1.280+, Sonnet 5.5 v2.1.284+, Haiku 5.5 v2.1.293+. 개발 시작 시 설치 버전을 확인한다.

| 작업 | 배정 |
|---|---|
| 아키텍처, shared-types 계약, FontManager, 리플로우 설계, 저장/undo 정책 | Opus. 어려운 원인 분석(렌더 깨짐·메모리·매핑)은 Fable 선택 |
| `pdf-ops` 콘텐츠 스트림 인터프리터·SourceMap·공유 객체 처리 | **Opus 설계·리뷰 + Sonnet 구현** (보일러플레이트로 분류하지 않음) |
| `apps/extension` 셸, `viewer-ui`, CI, 명세 확정된 테스트, Playwright | Sonnet |
| 문서 정리, 기계적 변환, 픽스처 관리 스크립트, 린트, 커밋 메시지 | Haiku |
| 골든 정답(정확도 라벨) 승인 | 원본을 확인하는 독립 검토(Opus 읽기 전용 세션 + 사람 확인) |
| 마일스톤 리뷰 | 구현 맥락과 분리한 읽기 전용 리뷰 세션. `/code-review high` 는 검토 수준이며, 리뷰 세션 모델을 Opus 로 지정하는 것과 별개로 설정 |

백그라운드(서브에이전트/별도 세션) 규칙
- 사용: 문서·API 리서치(Haiku/Sonnet 서브에이전트, 모델을 **서브에이전트 단위로 명시**), 테스트·벤치마크 실행과 요약, 마일스톤 리뷰(읽기 전용), 패키지별 병렬 구현(worktree 분리 세션).
- 금지: 여러 패키지를 가로지르는 인터페이스 변경, 같은 파일을 두 세션이 쓰는 것.
- **기준 커밋**: 병렬 구현 전 `shared-types`(공통 타입·RPC 계약)를 커밋하고 각 worktree 가 동일 기준 커밋에서 시작하게 한다. worktree 는 기본 브랜치에서 시작하므로 메인 세션의 미커밋 인터페이스는 공유되지 않는다. 각 작업에 **허용 변경 파일 목록과 완료 기준** 을 지정한다. 루트 설정·shared-types·lockfile 변경은 메인 세션에서만 통합한다.
- 세션 구성: 패키지별 세션 1개, 모델은 세션 단위 지정. 머지 전 `/code-review`, 머지는 메인 세션.
- 토큰 예산 가이드: 설계/리뷰 25%, 구현 55%, 문서/잡무 20%.

---

## 11. 환경 점검 (실측 여부·날짜 표시)

| 항목 | 이 PC (Windows) | Mustree 서버 (`sailab01`) |
|---|---|---|
| Node | 24.16.0 (실측 2026-10-18) | 22.18.0 (실측 2026-10-18) |
| pnpm | 미설치 (실측 2026-10-18, `npm i -g pnpm` 필요) | 미설치 (실측 2026-10-18, `npm i -g pnpm` 또는 `corepack enable pnpm` 필요) |
| git | 2.54 (실측 2026-10-18) | 2.34.1 (실측 2026-10-18) |
| npm | — | 10.9.3 (실측 2026-10-18) |
| npm `mupdf` 최신 버전 | — | 1.28.1 (실측 2026-10-18, `npm view mupdf version`) |
| Chrome 버전 / 검증한 가로채기 경로 | 사용자 기입(`chrome://version`) | 해당 없음 |
| Claude Code 버전 / 사용 가능 모델 | 사용자 기입 | 사용자 기입 |

서버 관찰 사항
- `npm` 실행 시 `config prefix cannot be changed from project config: /mnt/nas4/.npmrc` 경고가 출력된다(동작은 정상). 전역 설치(`npm i -g pnpm`) 시 prefix 설정 충돌 가능성이 있으므로 M0 Day 1 에서 `corepack enable pnpm` 경로를 먼저 시도한다.

---

## 12. M0 Day 1 체크리스트

1. `pnpm init` 모노레포, `packages/shared-types`·`core`·`pdf-ops`·`apps/extension` 뼈대, `mupdf` 설치 후 lockfile 고정, Vite 빌드로 wasm 자산 복사.
2. manifest(MV3, CSP, `mime_types_handler` + `can_embed`, DNR 폴백 규칙) → 로컬 Chrome 로드 → 세 문맥 가로채기 확인.
3. Worker 에서 1페이지 렌더 → 캔버스.
4. 스파이크: 하드코딩 좌표로 문단 redaction → 폴백 폰트 `addFont` 임베딩 → 새 스트림 추가 → 전체 저장 → 재열기·검색. 저장 방식·메모리 기록.
5. FSA 세 문맥 테스트, `chrome.downloads` 폴백.
