# PDF 편집기(Chrome 확장) 개발 계획

## 0. 문서 상태

| 항목 | 내용 |
|---|---|
| 버전 | v2.10 (v2 = 1차 안 리뷰 반영: 저장 정책 충돌, 폰트 임베딩 오해, 원본 연결 계층 누락, 지원 범위 불명확, M0 검증 순서, Chrome API 정정, 테스트 기준, 모델 배정, ML/태그 범위, 작성·검증 방식) |
| 작성일 | 2026-10-18 |
| 작성 환경 | Mustree 서버(호스트명 `sailab01`) `/mnt/nas4/kjune/pdf-editor`, Claude Code 세션에서 작성. Windows PC(`C:\Users\harry\pdf-editor\PLAN.md`)에는 scp 복사본만 둔다 |
| 리서치 근거 | MuPDF 1.28.x 공식 JavaScript/WASM 레퍼런스, Chrome 확장(MV3) 공식 문서, Claude Code 공식 문서 |
| 수치 표기 규칙 | 용량·버전은 "원본 / 압축 / 배포 번들" 기준과 측정 버전을 함께 적는다. 실측 전 값은 **문서 기준** 으로 표시하고, 실측 값에는 **실측 YYYY-MM-DD** 를 붙인다 |
| 상태 | 계획 문서. **M0 종료(2026-10-19)**: DoD 9항목 통과 4·제한 5, 잔여 해소 작업은 M1·M3 에 반영, 사용자 확인 잔여 4건(`docs/m0-closeout.md`). 근거 `docs/m0-day1-log.md`, `docs/m0-dod-xobject-redact-save.md`, `docs/m0-corpus-recheck.md`. M1 진행 중(`m1` 브랜치, 계약 `docs/m1-contract.md`) M1(2026-10-19, `m1` 브랜치): 세 작업 통합 완료(`docs/m1-integration.md`), 결정 항목 완료(`docs/m1-decisions.md`). 코퍼스 도형 번호 불일치 11쪽 해소(재측정 실패 0쪽), 마일스톤 리뷰 지적 반영(`docs/m1-decisions.md` 6절). 남은 것: `main` 머지(사용자 승인). **M2(2026-10-19, `m2` 브랜치, m1 포함)**: 레이아웃 복원 구현·정확도 하네스 완료(계약 `docs/m2-contract.md`, 결과 `docs/m2-accuracy.md`). 1차 test 목표 3/5(문단 F1 0.811·머리꼬리 0.837 미달) → 보강 라운드(dev2 조정, 문서 단위 2차 보류 test2) 후 test2 목표 5/5 충족(문단 F1 0.881, τ 0.986, 표 P/R 1.0, 행·열 0.714, 머리·꼬리 0.885). 라벨 41쪽 독립 검토 승인, 사람 확인 대기 |
| 변경 이력 | 2026-10-18 v2.1: 2절 "한글 폴백 폰트" 를 M0 Day 1 실측(P1: CFF OTF 실패 → glyf TTF 서브셋)으로 갱신. 2026-10-18 v2.2: 1.3·3.4 공유 Form XObject 정책 확정(편집 제한 L1–L7), 3.1 기존 Redact 주석 정책 확정·저장 방식 강제·저장 벤치마크 결과 요약, 5.4 실측 상한, 6절 재산정 메모, 7절 리스크 7·8 추가. 근거 `docs/m0-dod-xobject-redact-save.md`. 2026-10-19 v2.3: 11절 "Chrome 버전 / 검증한 가로채기 경로"(이 PC 열) 실측 기입, 0절 상태·변경 이력 갱신. 2026-10-19 v2.4: 6절 M1 에 텍스트 선택 층·Ctrl+F 작업 추가(Windows 검증 알려진 한계 반영), 4절 `viewer-ui` 책임·6절 재산정 메모·8절 "편집 동작" 축에 같은 항목 추가. 2026-10-19 v2.5: 7절 리스크 7 의 업스트림 보고 상태를 게시됨(mupdf.js#201)으로 갱신. 2026-10-19 v2.6: M0 종료·재산정 반영 — 0절 상태, 3.3 폰트 서브셋(C1), 3.1 redaction 재직렬화(C2), 3.4 공유 Form 코퍼스 결과(C3·C6), 5.1 가로채기 경계 150·DNR 128–149 제한, 5.4 실제 문서 힙 배율(C4), 6절 일정 재산정(M1 4주·M3 5주, MVP 2027-02-28)·M0 DoD 가로채기 행, 7절 리스크 9·10, 8절 코퍼스 방식, 11절 서버 Chrome 실측. 2026-10-19 v2.7: M1 결정 반영 — 3.1 텍스트 제거 경로(SourceMap 기반 제거 기본), 3.3 폴백 폰트만 서브셋 구현, 3.4 A1-1 해소, 5.1 DNR object 포함, 7절 리스크 10 대응, 0절 상태. 근거 `docs/m1-decisions.md`. 2026-10-19 v2.8: M1 리뷰 반영 — 3.1 텍스트 제거 대체 경로에 클립 텍스트(Tr 4–7)·MuPDF 대체 폰트·CID 매핑 없는 코드 추가, 명세 폭 계산, 공유 콘텐츠 스트림 사본, 0절 상태. 근거 `docs/m1-decisions.md` 6절. 그 외 절은 변경 없음 2026-10-19 v2.9: M2 결과 반영 — 상태(구현·하네스 완료, 목표 3/5), 2절 레이아웃 복원 행(stext 옵션 실측 후 입력에서 제외), 4절 M2 행 상태, 7절 4 실패 유형, 8절 코퍼스 A7-10 보강 5건(24건·1,992쪽)·라벨 41쪽. 2026-10-19 v2.10: M2 보강 라운드 결과 반영(test2 목표 5/5, 라벨 67쪽: dev 30·test 23·test2 14). |

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
| 공유 객체·클립·투명도 | 지원 조건 통과 객체만 편집. Form XObject 는 **확정(M0, 2026-10-18)**: 편집하는 사용 위치만 새 인스턴스로 교체(임시 페이지 redaction), 중첩이면 상위 체인도 인스턴스화. 3.4절 제한 조건 L1–L7 에 해당하는 사용 위치는 v1 편집 제한 + 사유 표시 | 전체 지원(L1–L7 해소) |
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
| 레이아웃 복원 | 자체 복원(`packages/layout-recon`)의 입력은 `PageModel`(stext 기본 줄 + Device 경로·이미지)만 쓴다. **2026-10-19 실측(`docs/m2-contract.md` 1.1)**: stext `table-hunt,segment` 는 표 행을 셀 하나로 합치고 각주 목록을 표로 보고해 입력에서 뺐다. 옵션 출력은 실패 유형 분석 뒤 보조 신호 후보 | 옵션만으로 완성된 셀/병합 구조가 나온다고 전제하지 않음 |
| ML | 선택 기능. 표·문단 후보 영역 탐지 보조. **채택 모델·체크포인트·라이선스·ONNX 변환물·입출력 스키마·다운로드 크기는 코퍼스 평가 후 확정** | 추론 런타임(onnxruntime-web)은 확장에 번들. 원격 다운로드는 모델 데이터만(Web Store 원격 코드 금지) |
| UI | Preact + Canvas 오버레이 | |
| 모노레포 | pnpm workspaces + turbo, Vitest, Playwright, ESLint/Prettier | |
| 배포 | GitHub(AGPL-3.0) + Chrome Web Store | |

---

## 3. 편집 엔진 설계

### 3.1 저장 정책
- `applyRedactions()` 적용 문서는 `canBeSavedIncrementally()` 가 false 가 되므로 **전체 저장(full save)이 기본 경로** 다.
- 규칙: 저장 방식은 변경 유형과 `canBeSavedIncrementally()` 결과로 결정한다. 증분 저장은 적용 가능한 변경(주석·메타 등 redaction 없는 변경)에 한정한다. `canBeSavedIncrementally()` 는 권고값이며 MuPDF 는 false 여도 증분 저장을 막지 않고 제거한 원문이 이전 리비전에 남는다(M0 Day 1 실측) → 텍스트·스트림 교체는 redaction 유무와 무관하게 **항상 전체 저장** 으로 앱(`pdf-ops.decideSaveMethod`)이 강제한다.
- 전체 저장의 **최대 메모리·저장 시간을 M0 부터 벤치마크** 한다(기준 문서·PC 조건 명시). WASM 배포 파일 크기는 실행 메모리 예산으로 쓰지 않는다.
  - M0 결과(실측 2026-10-18, 서버 Node, 합성 문서, `docs/m0-dod-xobject-redact-save.md` 3절): npm `mupdf` 1.28.1 의 편집 문서 저장 경로는 `saveToBuffer`(출력 전체를 WASM 힙 버퍼 1개로 생성) 뿐이며 **출력 스트리밍은 불가**(출력 콜백 export 없음, 사용자 정의 WASM 빌드 필요 → v1 범위 밖). 전체 저장 피크 WASM 힙은 파일 크기의 약 1.7~4.5배(작은 문서에서 배율이 크다).
  - 입력을 `Stream` 으로 열면(`openDocument(new Stream({fileSize, read, close}))`) 열기 시 힙 증가가 없어 피크가 파일 크기 약 1배만큼 줄고, 저장 결과는 Buffer 입력과 바이트 동일 → core 열기 경로를 Stream 입력으로 전환한다(M1, A3-1).
  - 저장 전 **예상 피크 힙 경고**(구현): `pdf-ops.decideSaveMethod(changes, canBeSavedIncrementally, { inputBytes })` 가 파일 크기 × 실측 배율로 `ok`(상한의 75% 이하) / `warn` / `over-limit` 을 돌려준다. 저장 방식은 바꾸지 않고 호출자(뷰어)가 경고·중단한다(shared-types 계약 추가는 M1, UI 는 M3). 저장 실패 시 같은 문서 재저장도 실패하므로 복구는 Worker 재시작 → 원본 재열기 → 편집 로그 재적용(3.2, M3).
  - `garbage=yes` 와 `garbage=compact` 의 피크 힙은 같다(출력은 `yes` 가 46~70 B 크다). `emptyStore()` 는 선형 메모리를 줄이지 못해 상한 대책이 아니다.
- redaction 은 "선택 글자만 지우는 함수" 가 아니다. `applyRedactions(blackBoxes=false, imageMethod, lineArtMethod, textMethod)` 의 이미지·선화·텍스트 옵션을 **텍스트 교체 용도로 명시 지정** 한다(기본: 텍스트 제거, 선화·이미지 보존).
- 기존 Redact 주석이 있는 문서 **확정(M0, 2026-10-18, `docs/m0-dod-xobject-redact-save.md` 2절)**: 열기 시 감지·보고(`pdf-ops.listRedactAnnots`, 쪽·개수). 편집용 redaction 은 **새로 만든 주석만 주석 단위 `applyRedaction()`** 으로 적용해 기존 Redact 주석을 적용·삭제·이동하지 않는다(페이지 단위 `applyRedactions()` 는 기존 주석까지 적용해 인접 문단을 지웠다). 편집 전 `assessRedactionImpact` 가 편집 영역과 겹치는 기존 Redact 주석(`warn`: 나중에 그 표시를 적용하면 새 텍스트도 지워짐)과 함께 제거되는 링크 주석(`warn`: MuPDF redaction 은 겹치는 링크를 지움, 복원 여부는 M3 A2-1)을 보고한다. 페이지 단위 적용이 꼭 필요한 작업만 Redact 주석을 임시 분리(`withRedactAnnotsDetached`) 후 실행하며, 분리 전 그 쪽의 `PDFPage` 를 모두 `destroy()` 한다(MuPDF 는 열려 있는 페이지의 `/Annots` 변경을 다시 읽지 않음). 기존 주석 적용 기능은 v1 범위 밖.
- **페이지 redaction 재직렬화(C2, 실측 2026-10-19)**: MuPDF 페이지 redaction 은 쪽 콘텐츠 전체를 다시 직렬화한다(실제 문서 연산자 906→2,069, 바이트 +37%). 원본 연산자 바이트 위치(SourceMap)가 무효가 되고, `ActualText` Span 이 있는 쪽에서 편집하지 않은 줄이 최대 3.1pt 이동했다(MuPDF 경고 `ActualText with no position`). **텍스트 제거 경로 확정(M1, 2026-10-19, `docs/m1-decisions.md` A7-2)**: SourceMap 기반 제거(`pdf-ops.removeTextShowOps`)를 기본으로 한다. 지울 Tj·TJ·'·" 연산의 바이트만 같은 총 전진량의 숫자 TJ 로 바꿔 뒤 글자 위치와 스트림의 나머지 바이트를 보존한다(코퍼스 100블록: 블록 밖 글자 위치 변화 0, redaction 은 블록 밖 렌더 변화 21/100). MuPDF redaction 은 이 함수가 건너뛰는 연산(Form 안·클립 텍스트 Tr 4–7·Type3·세로쓰기·폰트 폭 불확실·MuPDF 대체 폰트·CID 매핑 없는 코드)의 대체 경로로만 쓴다. 클립 텍스트를 빈 TJ 로 바꾸면 클립 경로에 글리프가 없어져 클립 안 그림이 드러난다(MuPDF 실측: 300×200 쪽 파란 칠 279 → 60,000 px). 전진량은 명세 폭(실수 /Widths·/W, `PdfFont.advanceSpec`)으로 계산하고, 다른 쪽 /Contents 나 같은 배열의 다른 칸과 공유한 콘텐츠 스트림은 사본을 만들어 이 쪽 칸만 바꾼다(M1 리뷰 반영).

### 3.2 undo/redo
- 모델: **원본 바이트 + 편집 로그(EditOp 리스트) 를 진실 원천** 으로 유지한다. 작업용 문서는 "원본 + 로그 재적용" 으로 재구성 가능해야 한다.
- 성능: N 단계마다 체크포인트(작업용 문서 스냅샷 바이트)를 저장하고, undo 는 가장 가까운 체크포인트에서 재적용한다. N 과 메모리 상한은 M0 벤치마크로 결정한다.
- 엔진 자체 변경 기록 기능은 M0 에서 검증 후 보조로만 채택한다.

### 3.3 FontManager
"동일 폰트로 리플로우" 의 정확한 정의: 원본 폰트의 재사용 가능 여부와 문자 커버리지를 확인한 뒤 우선 재사용한다. 재사용이 어려우면 지정 폴백 폰트를 **실제로 임베딩** 하고, 해당 편집 영역의 폰트 변경을 UI 에 표시한다.

| 상황 | 처리 |
|---|---|
| 원본 폰트 재사용 가능 + 새 글자 표현 가능(`encodeCharacter(cp) !== 0`) | 원본 폰트 리소스 재사용 |
| 원본이 서브셋이라 새 글자 없음 | 폴백 폰트 선택 → `new Font(name, bytes)` → `doc.addFont(font)`(Identity-H CID) 로 **폰트 바이트 포함 임베딩** → 저장 시 **폴백 폰트만 서브셋**(A7-1, 구현 `pdf-ops.subsetFontBytes`: 임시 문서에서 서브셋, gid 유지, 2.5 MB → 약 100 KB). MuPDF `subsetFonts()` 는 문서 전체 폰트를 다시 서브셋하며 원본 단순 폰트 `/Widths` 를 정수로 반올림해 편집하지 않은 쪽 렌더를 바꾸므로(C1, 실측 2026-10-19 pdfTeX 2/19 문서) 쓰지 않는다 |
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
- 공유 Form XObject **확정(M0, 2026-10-18, `docs/m0-dod-xobject-redact-save.md` 1절)**: 여러 페이지/위치에서 재사용되면 원본 수정 시 선택하지 않은 위치까지 바뀌므로, 편집하는 사용 위치는 공유 여부와 무관하게 **항상 새 인스턴스로 교체** 한다. 방식: 원 페이지와 같은 MediaBox·CropBox·Rotate 의 임시 페이지에 선택 위치의 최상위 Form 을 같은 CTM 으로 그리고 주석 단위 redaction(텍스트 제거, 선화·이미지 보존)으로 필터된 인스턴스를 얻은 뒤, 페이지 Resources 를 페이지 전용 사본으로 바꿔 새 이름을 등록하고 페이지 콘텐츠에서 해당 `Do` 의 이름 피연산자 바이트만 교체한다(임시 페이지는 삭제, 잔여 객체는 전체 저장에서 제거). 중첩 사용 위치를 편집하면 상위 체인도 인스턴스화한다. 합성 픽스처 실측: 비선택 위치·다른 쪽 렌더 diff 0 px(MuPDF·Poppler), 원본 객체 변경은 페이지 사전 1개. 실제 코퍼스(6문서 9개 Form) 재실행 9/9 정책 충족(2026-10-19, `docs/m0-corpus-recheck.md` 2.9). Form `/BBox` 는 정규화해 비교한다(비정규화 4/9, C3·A7-3), 새 텍스트 배치 영역은 원 텍스트 위치 ∩ BBox ∩ CropBox 로 제한한다(BBox ⊄ CropBox 2/9, C6·A7-4 M3).
  - v1 **편집 제한**(사유 표시)으로 판정하는 사용 위치: L1 Form 에 자체 `/Resources` 없음(페이지 리소스 상속), L2 `/StructParents`·MCID 포함(태그 PDF, 1.4 태그 정책으로 처리), L3 새 텍스트가 Form BBox 초과(자동 클립 금지와 충돌, BBox 확장 미구현), L4 페이지 콘텐츠 밖 사용(주석 외관 AP·타일링 패턴·Type3 글리프·SMask), L5 재귀 깊이 > 8 또는 순환 참조, L6 토크나이저 실패 또는 이름 피연산자가 Contents 배열 스트림 경계에 걸침, L7 `/OC` 선택적 콘텐츠(경고만).
  - A1-1(Form 이 있는 페이지 직접 편집 시 모든 Form 인스턴스화) **해소(M1)**: 텍스트 제거에 페이지 redaction 을 쓰지 않는다(3.1). Form 안 텍스트는 M3 에서 편집 위치 인스턴스 복제 후 복제본 스트림에 SourceMap 기반 제거를 적용하고, `redactFormUsage` 는 대체 경로로 둔다.

---

## 4. 모듈 아키텍처

| 패키지 | 책임 |
|---|---|
| `packages/shared-types` | `PageModel`, `DocumentModel`, `SourceMap`, `EditOp`, `EditPlan`, Worker RPC 계약. **병렬 구현 전 커밋·고정** |
| `packages/core` | MuPDF 객체 수명, 문서 상태(원본 바이트·로그·체크포인트), Worker RPC(Comlink). `open`, `renderPage`, `extractPage`, `applyEditPlan`, `save` |
| `packages/pdf-ops` | 콘텐츠 스트림 인터프리터(SourceMap 생성), redaction 래퍼, 배치 결과 → PDF 연산자 직렬화, 원본 객체 반영(스트림 교체/추가, XObject 복제), 저장 방식 결정 |
| `packages/layout-recon` | `PageModel → DocumentModel`. MuPDF 플래그 + 열/표 휴리스틱(PyMuPDF `find_tables` lines/text 전략 포팅). ML 플러그인 슬롯 |
| `packages/reflow` | 텍스트 셰이핑(`advanceGlyph` → harfbuzz)과 줄·글리프 배치 결정(`layoutParagraph → Line[]/Glyph[]`). 직렬화는 하지 않음 |
| `packages/viewer-ui` | Preact 캔버스 + 오버레이 에디터(문단, 셀, 벡터 핸들), 초과 상태 UI, 편집 가능 표시, undo/redo UI, **텍스트 선택 층·검색 UI**(`PageModel` 기반 선택·복사, Ctrl+F 가로채기·하이라이트, M1) |
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
- **v1 기준: Chrome 150+ 공개 MIME handler**(Chrome for Testing 150.0.7871.0 이상에서 `chrome.mimeHandler` 실측 2026-10-19, 150.0.7828.0·149 없음. 정식 Chrome 150 확인 전). manifest `mime_types_handler: {"application/pdf": {handler_url, can_embed: true}}`.
- 조건: `getStreamInfo()` 는 MIME handler 문맥에서 호출한다. `streamUrl` 은 **한 번만 fetch** 하고 `originalUrl` 재요청은 금지한다. 전체 스트림 수신 후 지원 여부를 판정하고, 미지원이면 `abortAndFallbackToNativeHandler()` 를 호출한다. file:// 은 별도 파일 URL 설정이 불필요하다. POST 생성 PDF·일회성 URL 대응은 이 규칙으로 보장한다.
- 구버전 호환(별도 지원 범위, v1 보장 아님): `declarativeNetRequest` 응답 헤더 조건(`content-type: application/pdf`) 리다이렉트는 **Chrome 128–149 의 제한적 경로** 다(CfT 128·140·149 실측 2026-10-19, `docs/m0-corpus-recheck.md` 4절). 제한: 뷰어가 원 URL 을 다시 받는다(GET 2회), POST·`content-disposition: attachment` 는 가로채지 않는다. 규칙 대상 자원에 `object` 를 넣어 embed·iframe·object 를 모두 가로챈다(A5-2, CfT 140·149 실측 2026-10-19), file:// 는 "파일 URL에 대한 액세스 허용" 이 켜져 있어야 동작한다(안내 UI A5-3). 128 미만은 미지원.

### 5.2 실행 위치·보안
- MuPDF 와 문서 상태는 **뷰어 소유 module Worker** 에서 관리한다. 확장 서비스 워커는 navigation 폴백과 전역 이벤트만 담당한다. SharedArrayBuffer 불필요(단일 스레드 빌드).
- CSP: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.

### 5.3 저장 요구사항
- MIME handler 로 바이트를 받았다고 쓰기 핸들이 생기지 않는다.
- **최초 저장 시 사용자가 저장 대상을 선택(FSA `showSaveFilePicker`)** → 쓰기 권한 확보 후 동일 핸들로 Ctrl+S 재저장.
- HTTP 로 연 PDF 는 사용자가 지정한 로컬 파일에 저장한다. FSA 불가 시 `chrome.downloads` 폴백.
- M0 에서 **일반 뷰어 페이지 / 최상위 MIME handler / 임베디드 MIME handler** 세 문맥을 나눠 FSA 가용성을 확인한다.

### 5.4 메모리
- 페이지 단위 지연 추출, 렌더 캐시 LRU, 전체 저장 시 피크 메모리 측정. WASM 힙 상한 2GiB(2,147,483,648 B, memory64 빌드 아님. 선형 메모리는 계단식으로 늘고 줄지 않는다).
- 실측 상한(2026-10-18, 서버 Node, 합성 문서, 1쪽 문단 교체 후 전체 저장): Buffer 입력 525.5 MiB 성공 · 675.7 MiB **실패**(`realloc` 예외, 같은 문서 재저장도 실패) / Stream 입력 675.7 MiB 성공(피크 1,681 MiB, 상한의 82%). 브라우저 탭은 JS 쪽 입력·출력 사본이 더해지므로 Windows Chrome Worker 에서 재측정한다(A3-4). `decideSaveMethod` 경고 경계(전체 저장): Buffer 배율 4.48 → `warn` > 342.9 MiB, `over-limit` > 457.1 MiB; Stream 배율 3.48 → `warn` > 441.4 MiB, `over-limit` > 588.5 MiB(보수적 판정, 이번 측정에서 미탐 0건, 배율 모델 재산정은 M5 A3-5).
- 실제 코퍼스 19건(최대 492쪽, 2026-10-19)의 순수 저장 힙 증가분은 파일 크기의 0~19.1배로, 파일 크기 비례 배율 모델은 객체 중심 대형 문서에서 과소 추정할 수 있다(C4). 객체 수·디코드 스트림 크기 항을 넣은 모델로 재산정하고 100 MB 이상 실제 문서로 경계를 검증한다(A7-5).

---

## 6. 마일스톤 (2026-10-19 재산정: M1–M5 19주, MVP 목표 2027-02-28)

| 단계 | 기간 | 완료 기준(DoD) |
|---|---|---|
| **M0 핵심 편집 가능성 검증** | 완료(2026-10-18~19, 계획 3주) | 모노레포 초기화 + 최소 확장 셸 + 아래 "M0 DoD" 전부 통과. 결과로 v1 범위·일정 재산정 문서 작성 → **종료 판정·재산정 `docs/m0-closeout.md`** |
| M1 추출·원본 연결 | 4주(2026-10-19~11-15) | `PageModel` + `SourceMap` 생성, Form XObject 재귀, 매칭 실패율 측정. 디버그 오버레이. 코퍼스 회귀 테스트. **텍스트 선택 층·Ctrl+F**(2026-10-19 추가, 근거 `docs/m0-day1-log.md` 9.5): 캔버스 위에 `PageModel` chars 의 quad·유니코드로 투명 텍스트 선택 층을 두어 드래그 선택·Ctrl+C 복사(클립보드 텍스트 = 추출 유니코드), 뷰어가 Ctrl+F 를 가로채 문서 전체 검색(현재 쪽 우선, 결과 수·이전/다음·quad 하이라이트). DoD: Playwright 로 선택→복사 결과가 추출 텍스트와 일치, 검색 하이라이트 위치가 quad 와 일치, 확장이 켜진 상태에서 Chrome 기본 뷰어와 같은 검색·복사 가능. **실제 코퍼스·Windows 검증 반영(2026-10-19)**: 폴백 폰트만 서브셋(A7-1), 텍스트 제거 경로 결정(A7-2), 사각형 정규화(A7-3), 가로채기 경계 150·DNR object(A5-1·A5-2), A1-1·A1-3·A2-3·A3-6 결정 |
| M2 레이아웃 복원 | 4주(2026-11-16~12-13) | 문단/열/표 복원, 읽기 순서. **정답 라벨 기반 정확도** 하네스. stext 줄 병합 문단 복원(A7-6: Word·InDesign·한컴 출력은 한 줄 블록 비율 최대 1.0), 정답 라벨용 코퍼스 보강(A7-10) **2026-10-19 구현 완료(`m2`)**: 시각 줄·영역 쌓기·문단 나누기·XY-cut·표(괘선·띠 닫기·정렬)·도형·머리꼬리·모양 구간, core `getPageLayout`, 뷰어 레이아웃 오버레이, 하네스·라벨 41쪽. test: 문단 F1 0.811(미달)·τ 0.964·표 P/R 1.0·행열 0.667·머리꼬리 0.837(미달). A7-6(한 줄 블록 출력기)은 stext 블록을 쓰지 않는 방식으로 해소(Word 쪽 문단 일치) **보강 라운드(2026-10-19)**: 표시 수식·글머리·국소 줄 끝·가운데 정렬·이웃 쪽 반복 머리꼬리 보강 후 문서 단위 2차 보류 test2 에서 목표 5/5(`docs/m2-accuracy.md` 6절) |
| M3 텍스트 재작성 | 5주(2026-12-14~2027-01-17) | 문단 편집 → 리플로우(영역 내) → 초과 UI → 저장. 라틴 후 한글. harfbuzz. undo(체크포인트). **IME 조합 시나리오**. 태그 정책 구현. Form·문단 배치 영역 ∩ CropBox(A7-4), 태그 PDF 기본 동작 설계 초기 확정(A7-7, 편집 문단 31/53 이 태그 쪽), 링크 복원(A2-1·A7-8), 저장 실패 복구(A3-3), Redact 보고 UI(A2-2), DNR file:// 안내(A5-3) |
| M4 표/도표 편집 | 3주(2027-01-18~02-07) | 셀 텍스트 수정(초과 선택 UI), 벡터 좌표·선·채움 편집, 편집 가능 판정 UI |
| M5 안정화/배포 | 3주(2027-02-08~02-28) | 대용량 벤치마크 목표 달성, 폰트 서브셋, Web Store 패키징, 문서화. 저장 힙 예측 모델 재검증(A7-5) |

재산정(2026-10-19, `docs/m0-closeout.md` 5절): M0 는 계획 3주 대신 2일에 끝났다. 실제 코퍼스·Windows 검증에서 나온 작업을 M1(+1주)·M3(+1주)에 더해 M1–M5 를 19주로 잡는다. 실시간 편집 UI 는 M3 시작(2026-12-14 주)부터 동작한다. 패키지별 병렬 세션을 계속 쓴다는 전제이며 완충 기간은 없다. M1 종료 시 코퍼스 매칭 실패율로 M2 이후를 다시 산정한다.

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
| 가로채기 | 150+ mimeHandler(최상위/임베디드/file://), 128–149 DNR(file:// 포함) 실측(2026-10-19 경계 정정 151→150) |

M0 최종 판정(2026-10-19): 통과 4(텍스트 교체·새 한글 입력·텍스트 의미 보존(엔진)·가로채기), 제한 5(주변 보존·저장 후 재열기·저장 방식(브라우저)·첫 저장·재저장·공유 XObject 배치). 항목별 근거와 이관은 `docs/m0-closeout.md` 1절.

---

## 7. 리스크와 대응

1. 리플로우 충실도(커닝/힌팅, Form XObject·클립·공유 스트림) → "편집 블록만 교체, 나머지 원본 유지" + 편집 가능 판정 + 시각/텍스트/객체 3축 검증.
2. 폰트 임베딩·매핑(서브셋, non-Identity CMap, ToUnicode) → FontManager 표(3.3절) + M0 검증.
3. 전체 저장 메모리/시간 → M0 벤치마크(결과 3.1·5.4절), 체크포인트 상한, 지연 로딩.
4. 레이아웃 휴리스틱 한계 → 정확도 하네스로 실패 유형 수집 후 ML 옵트인 판단. **M2 측정(2026-10-19, `docs/m2-accuracy.md` 3절)**: 미달 원인은 글머리 넘김 줄 분리(목록 항목 19), 표시 수식 분할(7), 첫 쪽 마스트헤드 미검출로 좁혀졌고 모두 휴리스틱 보강 후보다. 표·도형 위치 검출 실패는 없어(표 P/R 1.0) ML 후보 탐지의 필요 근거는 아직 없다. 보강 라운드 후 test2 목표 5/5 충족. 남은 실패(인라인 큰 수식 줄, Hancom 한문 예문, 제목 블록)와 도형 P/R 0.5 는 계속 휴리스틱 보강 대상이며 ML 필요 근거는 아직 없다.
5. Chrome 구버전 호환 → v1 범위 밖으로 관리, 안내 UI.
6. `mupdfjs` 폐기, `PDFProcessor` 불가 → pdf-ops 인터프리터 자체 구현(Opus 설계).
7. **MuPDF 1.28.1 결함 F3**(실측 2026-10-18): 압축 필터가 있는 이미지 XObject(JPEG `DCTDecode`, Flate)를 `PDFObject.resolve()` 한 문서를 `garbage=compact`(또는 `deduplicate`)로 저장하면 그 이미지가 스트림 없는 사전으로 기록되어 재열기 시 `object is not a stream` 오류와 이미지 소실이 난다(`destroy()` 해도 같음, `garbage=yes`·garbage 없음은 정상) → **회피 규칙**: 저장할 작업 문서에서 이미지 XObject 를 `resolve()` 하지 않는다(사전 값은 간접 참조 `get()`, 렌더는 `loadImage(ref)`). M1 `PageModel`·`SourceMap` 구현 리뷰 항목으로 고정(A2-3). 대안인 전체 저장 옵션 `garbage=yes` 전환(피크 힙 동일, 출력 46~70 B 증가, Day 1 고정 해시 변경)은 M1 에서 결정(A3-6). 대조 테스트 `tools/spike-m0/test/mupdf-pitfalls.test.ts` 가 MuPDF 동작 변화를 감지한다. 업스트림 보고: 2026-10-19 [ArtifexSoftware/mupdf.js#201](https://github.com/ArtifexSoftware/mupdf.js/issues/201) 게시(A2-4). 1.26.4·1.27.0 미재현·1.28.1 재현(회귀), 원인 분석·수정 제안 포함, 게시 문안·재현 스크립트 `docs/upstream/`.
8. 대형 문서 전체 저장 실패(WASM 힙 상한, 출력 스트리밍 불가) → 저장 전 예상 피크 힙 경고(3.1), 입력 Stream 열기(M1), 실패 시 Worker 재시작·원본 재열기·편집 로그 재적용 복구(M3), Windows Chrome 실측 후 지원 문서 크기 상한 안내 UI.
9. **MuPDF `subsetFonts()` 부작용(C1, 실측 2026-10-19)**: 문서 전체 폰트를 다시 서브셋하며 원본 단순 폰트 `/Widths` 를 정수 반올림·미사용 글리프 0 으로 다시 써, pdfTeX 문서의 편집하지 않은 쪽이 Poppler·pdf.js 에서 바뀐다(MuPDF 렌더는 동일) → 폴백 폰트만 서브셋(A7-1, M1).
10. **페이지 redaction 재직렬화(C2)**: 쪽 콘텐츠 전체 재작성으로 원본 바이트 위치가 사라지고 `ActualText` 줄이 이동할 수 있다 → **대응 확정(M1)**: SourceMap 기반 제거를 기본 경로로 채택(3.1), redaction 은 대체 경로에서만 쓰고 그때 `ActualText with no position` 경고를 편집 제한 신호로 사용.

---

## 8. 테스트 계획

- 회귀 기준 vs 정확도 기준을 구분한다. 골든 JSON 은 회귀용이다. 정확도는 **원본을 확인한 독립 검토자가 승인한 정답 라벨**(문단 경계·셀·읽기 순서)로 측정한다. 생성 스크립트 출력은 검토 없이 정답으로 확정하지 않는다.

검증 축

| 축 | 내용 |
|---|---|
| 시각 | 편집 영역 밖 변화, 잘림, 중복, 배경·선 손상(픽셀 diff 는 이 축의 일부) |
| 텍스트 | 검색·복사·재추출, Unicode 매핑 |
| 객체 | 다른 페이지·공유 객체의 의도치 않은 변경(객체 diff) |
| 편집 동작 | undo/redo, 연속 수정, 저장 후 재편집, IME, 뷰어 텍스트 선택·복사·Ctrl+F(M1) |
| 성능 | 첫 렌더, 편집 반응, 저장 시간, 피크 메모리. 벤치마크 문서 세트와 PC 조건을 먼저 정한 뒤 목표 수치 설정 |

- 코퍼스 `fixtures/`: 한글 논문, 영문 보고서, 다단 뉴스레터, 표 중심 재무 문서, 벡터 차트 문서, 태그 PDF, 공유 XObject 문서 각 2~3개 + 수백 페이지 벤치마크 1~2개. **구축 완료(2026-10-19)**: 19건·1,647쪽, 공공영역·CC BY 4.0 만. PDF 는 커밋하지 않고 `fixtures/corpus/manifest.json`(URL·라이선스 근거·SHA-256)과 내려받기 스크립트 `scripts/corpus/fetch-corpus.mjs` 만 커밋한다. 보강 목록(학술지 한글 CC BY 논문, 공공누리 제1유형, 한국어 수백 쪽, 100 MB 이상, 기존 Redact 주석 문서, 표 셀 편집용)은 A7-10. **A7-10 보강(2026-10-19)**: 공공누리 제1유형 3건(국회예산정책처 2·국가데이터처 Hancom 1), CC BY 4.0 한국어 학술지 2건 추가 → 24건·1,992쪽. 남은 보강: 한국어 수백 쪽, 100 MB 이상, 기존 Redact 주석 문서, 표 셀 편집용. 정확도 라벨 `fixtures/labels` 67쪽(dev 30·test 23·test2 14, 독립 검토 승인, 사람 확인 대기).
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
| Chrome 버전 / 검증한 가로채기 경로 | 155.0.8059.82 공식 빌드 64비트 (측정 2026-10-19, 뷰어 진단 JSON). 가로채기 경로 MIME handler(`interceptionMode` "mime-handler", DNR 동적 규칙 0개): 최상위 https·file://, 임베디드(embed·iframe·object), 뷰어 페이지 통과. Chrome 128–149 DNR 경로는 이 PC 에서 미확인(해당 환경 없음, 서버 CfT 실측은 오른쪽 열). 상세 `docs/m0-day1-log.md` 9절 | Chrome for Testing 128·140·149: DNR 경로 동작(http GET·file:// 파일 URL 접근 켬), 150.0.7871.124: MIME handler 경로(실측 2026-10-19, 헤드리스, `docs/m0-corpus-recheck.md` 4절) |
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
