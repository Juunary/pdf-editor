# M0 Day 1 작업 기록

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-18 |
| 범위 | PLAN.md 12절 M0 Day 1 체크리스트 1–5 |
| 수행 위치 | Mustree 서버 `sailab01` `/mnt/nas4/kjune/pdf-editor` |
| 측정 표기 | 이 문서의 수치는 모두 **실측 2026-10-18**, 서버(Node) 기준. Windows Chrome 수치는 9절 체크리스트로 별도 기록 |

## 1. 상태 요약

| # | 체크리스트 | 서버 상태 | Windows 확인 |
|---|---|---|---|
| 1 | 모노레포·mupdf 고정·wasm 복사 | 완료 | 해당 없음 |
| 2 | manifest·viewer·Worker, 세 문맥 가로채기 | 완료. 헤드리스 Chromium 156 에서 MIME handler 세 문맥 동작 확인. DNR(128–150) 경로는 미실측 | 1차 완료 2026-10-19(Chrome 155, 9.1). 미확인: I4(로컬 http 임베드), I7(128–150 DNR) |
| 3 | Worker 1페이지 렌더 → 캔버스 | 완료 | 완료 2026-10-19(9.2) |
| 4 | 스파이크(redaction → 한글 임베딩 → 전체 저장 → 재열기·검색) | 완료, 통과(MuPDF·Poppler) | Chrome 기본 뷰어 표시·검색·복사 통과 2026-10-19(9.3 V1). 미확인: V2 Acrobat, V3 pdf.js, V4 대형 문서 측정 |
| 5 | FSA 세 문맥·downloads 폴백·Playwright | 완료. downloads 는 세 문맥 동작, FSA 실제 쓰기·재저장은 헤드리스 한계로 미확인 | 세 문맥 FSA 선택기·downloads 동작 2026-10-19(9.4). 미확인: 임베디드 문맥 F3 의 Ctrl+S 재저장 |

완료 기준: `pnpm build`, `pnpm test`(Vitest 45건 — OTF 대조 1건 포함, OTF 원본이 없으면 건너뜀 — + Playwright 1건) 서버 통과(2026-10-18).

## 2. 환경·도구 버전

| 항목 | 값 |
|---|---|
| 서버 | AMD Ryzen 9 5950X 16C/32T, RAM 125.7 GiB, Linux 6.8.0-138 x64, NFS 마운트 |
| Node | v22.18.0 |
| pnpm | 11.28.6 (corepack 0.33.0, `packageManager` 고정). `corepack enable pnpm` 성공. 최신 12.14.0 은 corepack 0.33.0 에서 실행 불가(`bin/pnpm.cjs` 없음) → 11.x 고정. `npm i -g` 경로 미사용 |
| turbo / Vite / Vitest | 2.11.9 / 8.3.4 / 5.0.5 |
| TypeScript | 6.0.3 (typescript-eslint 8.71.2 가 `typescript <6.1.0` 요구. 최신 7.0.2 미사용) |
| ESLint / Prettier | 10.13.0 / 3.9.10 |
| mupdf | 1.28.1 (package.json 정확 버전 + `pnpm-lock.yaml`). wasm 10,409,826 B 원본 / 3,632,923 B brotli(npm 배포 `.br`) |
| Playwright | 1.64.1, 번들 Chromium 1248 = Chrome for Testing 156.0.8078.4 |
| Poppler | 22.02.0 (`pdftotext`, `pdffonts`, `pdftoppm`) — MuPDF 와 독립 구현 교차 확인용 |
| `/mnt/nas4/.npmrc` | `prefix=/home/sai/.local`. npm 실행마다 `config prefix cannot be changed from project config` 출력, 동작 영향 없음 |

## 3. 체크리스트 1: 모노레포

- 구성: `packages/shared-types`, `packages/core`, `packages/pdf-ops`, `apps/extension`, `tools/spike-m0`(M0 검증 전용, M0 종료 후 정리 대상).
- 라이선스: `LICENSE` = GNU AGPL v3 전문, package.json SPDX `AGPL-3.0-or-later`(MuPDF 와 동일 표기).
- wasm 복사: Vite 가 Worker 번들의 `new URL('mupdf-wasm.wasm', import.meta.url)` 을 자산으로 출력 → `dist/assets/mupdf-wasm-<hash>.wasm`. `scripts/verify-dist.mjs` 가 빌드마다 원본과 sha256 일치(`5a30ef7b027f…`), 1개만 존재, MuPDF 코드가 Worker 청크에만 있음을 확인한다.

## 4. 체크리스트 2·3: 확장 셸·렌더(서버 확인분)

- manifest: MV3, `minimum_chrome_version` 128, CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`, `mime_types_handler` `{"application/pdf": {"handler_url": "viewer.html", "can_embed": true}}`, `declarativeNetRequestWithHostAccess`·`downloads`, `host_permissions: <all_urls>`, `viewer.html` web_accessible_resources.
- 가로채기 경로: 서비스 워커가 설치·시작 시 `chrome.mimeHandler` 유무와 UA 주 버전으로 결정.
  - API 있음 → MIME handler, DNR 규칙 제거
  - API 없음 + 128–150 → dynamic rule 2개: http(s) GET + `content-type: application/pdf`(`content-disposition: attachment*` 제외), `file://…\.pdf`(대소문자 무시)
  - 정적 ruleset 미사용 사유: `regexSubstitution` 에 확장 ID 가 든 뷰어 URL 이 필요, 151+ 에서 규칙이 남으면 MIME handler 보다 먼저 리다이렉트됨
- 뷰어 문맥 판정: `mime-handler-top` / `mime-handler-embedded` / `url-param`(DNR 리다이렉트·`?file=`) / `viewer-page`. MIME handler 문맥은 `streamUrl` 1회 fetch, `originalUrl` 은 표시만. 열기 실패 시 `abortAndFallbackToNativeHandler()`.
- Worker: 뷰어 소유 module Worker 에서 MuPDF·문서 상태 관리(Comlink). 메인 스레드 번들에 MuPDF 미포함.
- 결함 1건 발견·수정: module Worker 가 MuPDF top-level await(wasm 로드) 중 받은 첫 RPC 메시지를 리스너 부재로 잃어 `open` 이 응답하지 않음 → Worker 진입점에서 Comlink 리스너를 동기 등록하고 MuPDF 구현은 동적 import.
- Playwright 번들 Chromium 156(headless) 확인(자동 테스트는 5절):
  - `viewer.html?file=http://…` 렌더 완료
  - http PDF 직접 이동 → MIME handler 가 PDF URL 페이지 안의 `viewer.html` 하위 프레임으로 가로채 렌더(`window.top !== window`)
  - `<embed>`·`<iframe>`·`<object>` 3종 모두 `mime-handler-embedded` 로 렌더(http 페이지, 확장 페이지 양쪽)
  - 비PDF 응답(`diag/not-a-pdf.pdf`, `content-type: application/pdf`) → 열기 실패 → `abortAndFallbackToNativeHandler()` → Chrome 기본 PDF 뷰어(`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html`)로 전환 확인(임시 스크립트)

## 5. 체크리스트 5: FSA·downloads·Playwright

### 5.1 구현

- `apps/extension/src/viewer/save-target.ts`
  - "다른 이름으로 저장": FSA `showSaveFilePicker` → 쓰기 → 핸들 보관
  - "저장"/Ctrl+S: 보관한 핸들에 덮어쓰기(`queryPermission` → 필요 시 `requestPermission`). 핸들이 없으면 "다른 이름으로 저장"
  - FSA 미지원·피커 오류(SecurityError 등) → `chrome.downloads.download({saveAs: true, conflictAction: 'uniquify'})`. 사용자 취소(AbortError)는 폴백하지 않음
  - 피커·권한 요청을 먼저 하고 Worker 저장 바이트는 그 뒤에 받는다(사용자 활성화 만료 방지)
- 뷰어 툴바: "다른 이름으로 저장", "저장"(Ctrl+S, Shift+Ctrl+S = 다른 이름으로), "downloads 저장"(진단용 강제 경로). 결과는 진단 로그 `save` 항목(문맥, `isTopLevel`, channel, status, fsaError, 재사용 여부)
- 진단 패널 "전체 저장 측정": 브라우저 Worker 에서 전체 저장 시간·WASM 힙 기록(파일 저장 없음)
- `dist/diag/embed-test.html`: `<embed>`·`<iframe>`·`<object>` 로 `m0-sample.pdf` 를 임베드(임베디드 문맥 수동 확인용)

### 5.2 서버 자동 검증

| 구분 | 내용 | 결과 |
|---|---|---|
| 단위(Vitest) | 최초 FSA 저장 → Ctrl+S 같은 핸들 덮어쓰기(피커 1회, 쓰기 2회) / SecurityError → downloads / AbortError → 폴백 없음 / FSA·downloads 부재 / 재저장 권한 거부 / 파일명 정리 | 6건 통과 |
| Playwright 1건 (`apps/extension/e2e/extension.spec.ts`) | 번들 Chromium 156.0.8078.4, persistent context, `channel: 'chromium'`, headless. 서비스 워커 기동, MIME handler 경로(동적 규칙 0개), 세 문맥 렌더·캔버스 잉크, 문맥별 downloads·FSA 호출 | 통과 |

Playwright 문맥별 결과(헤드리스, 서버):

| 문맥 | 배지 | `window.top === window` | `showSaveFilePicker` | FSA "다른 이름으로 저장" | downloads 저장 |
|---|---|---|---|---|---|
| 일반 뷰어 페이지 | `url-param` | true | 있음 | 피커 단계 도달, AbortError(헤드리스 자동 취소) → `cancelled` | 다운로드 이벤트, 11,674 B |
| 최상위 MIME handler | `mime-handler-top` | **false** | 있음 | 동일(SecurityError 없음) | 동일 |
| 임베디드 MIME handler(embed/iframe/object) | `mime-handler-embedded` ×3 | false | 있음 | 동일(SecurityError 없음) | 동일 |

- 최상위 MIME handler 도 PDF URL 페이지의 하위 프레임이다. 헤드리스 Chromium 156 에서는 두 MIME handler 문맥 모두 교차 출처 하위 프레임 제한(SecurityError) 없이 피커 단계까지 갔다.
- 헤드리스 피커는 즉시 취소되므로 실제 파일 쓰기와 같은 대상 Ctrl+S 재저장은 서버에서 확인할 수 없다 → 9.4.
- 번들 Chromium 은 151+ 이므로 DNR 폴백(128–150) 경로는 자동화되지 않았다 → 9.1 G3·I7.

## 6. 체크리스트 4: 스파이크 결과

### 6.1 절차

`pnpm spike` (= `tools/spike-m0` 빌드 후 `node dist/cli.js`). 결과 원본: `out/m0-day1/spike-result.json`(git 제외). 변형·벤치마크는 각각 별도 Node 프로세스로 실행해 피크 메모리를 분리한다. 검증 렌더는 scale 2(1190×1684 px).

1. 샘플 `fixtures/m0/m0-sample.pdf`(A4 1쪽, 11,674 B, sha256 `913c521a…5144`) 열기. 대상 문단(Helvetica 4줄)이 옅은 배경 패널 위에 있고 가로·세로 괘선이 지나며, redaction 영역 안에 이미지가 있다. 원본 글꼴은 Helvetica 뿐이다.
2. 하드코딩 좌표 `[56, 128, 540, 192]`(MuPDF 페이지 좌표) Redact 주석 생성 → 주석 단위 `applyRedaction(black_boxes=0, image=NONE, line_art=NONE, text=REMOVE)`.
3. `new Font('NotoSansKR', bytes)` + `doc.addFont(font)` 로 폴백 폰트 임베딩. 원 문단 영역 `[56, 128, 470, 192]` 에 한글 문단 배치(11pt, 줄 간격 1.4, 어절 단위 줄바꿈, 넘침 시 자르지 않고 보고).
4. 페이지 Font 리소스 등록 + 원 콘텐츠 `q … Q` 감싸기 + 새 콘텐츠 스트림(Identity-H glyph id, 클립 연산자 없음) 추가.
5. `canBeSavedIncrementally()` 기록 → `subsetFonts()` → `decideSaveMethod()` → `saveToBuffer()`.
6. 재열기 → 텍스트 추출·검색, 렌더를 "폰트 파일에서 직접 그린 참조 렌더"와 픽셀 비교, 폰트 객체 검사. Poppler 로 교차 확인.

### 6.2 결과(Noto Sans KR 서브셋 TTF) — 통과

| 항목 | 결과 |
|---|---|
| 저장 방식 | **전체 저장** `garbage=compact,compress` (사유: redaction 포함) |
| `canBeSavedIncrementally()` | 열기 직후 `true` → redaction 후 **`false`** → 폰트·스트림 추가 후 `false` |
| 피크 메모리 | WASM 선형 메모리 **22.0 MiB**(23,068,672 B, 초기 크기에서 증가 없음) / Node 프로세스 maxRSS 154.6 MiB(검증 렌더 포함) |
| 저장 시간 | `subsetFonts()` **5.0 ms** + 전체 저장 **3.4 ms** |
| 단계별 시간 | 열기 7.1 ms, redaction 2.8 ms, 폰트 임베딩 6.7 ms, 스트림 추가 0.7 ms, 재열기+추출+검색 4.9 ms |
| 출력 | 20,766 B, sha256 `58b19a53…f468` (`fixtures/m0/m0-spike-saved.pdf`, 재실행 시 동일 해시) |
| 재열기 검색 | **성공**: `한글`, `폴백 폰트`, `임베딩`, `검색과 복사` 각 1건. 추출 텍스트에 새 문단 포함, 제거 문단 없음, 제목·인접 문단·꼬리말 유지 |
| 주변 보존 | redaction 결과 vs 기대 페이지(대상 문단만 뺀 원본) **0 px 차이**, 영역 밖 0 px 차이 → 배경·괘선·테두리·이미지·인접 텍스트 보존 |
| 글리프 표시 | 저장 전·재열기 렌더 vs 참조 렌더 **0 px 차이**(참조 잉크 5,509 px) |
| 폰트 객체 | `Type0` / `CIDFontType2` / `FontFile2` 105,394 B(서브셋) / BaseFont `FGKOBQ+NotoSansKR` / ToUnicode 있음 |
| 배치 | 2줄, 78 글리프, 누락 글자 0, 넘침 없음 |
| Poppler 22.02.0 | `pdftotext` 추출 일치, 검색어 4/4, `pdffonts` emb yes / sub yes / uni yes. `pdftoppm` 표시 정상(육안) |

### 6.3 대조: CFF 기반 OTF(notofonts SubsetOTF/KR) — 실패

PLAN.md 2절은 "Noto Sans KR 서브셋 OTF" 로 적었다. 같은 절차를 CFF OTF(4,644,748 B)로 실행한 결과:

| 항목 | 결과 |
|---|---|
| 재열기 렌더 vs 참조 | **10,344 px 차이**, 잉크 2,788 / 5,489 px. 한글 대부분 미표시 또는 다른 CJK 글리프 |
| MuPDF 로그 | `FT_Load_Glyph(…): invalid argument` 250건, `cannot render glyph`, `subsetFonts()` 중 `format error: Index bounds`(예외 없음) |
| 서브셋 | 미적용(BaseFont 태그 없음, `FontFile3` 4,644,748 B 그대로) → 출력 3,778,780 B, 저장 163 ms, WASM 힙 31.8 MiB |
| 텍스트 추출·검색 | MuPDF·Poppler 모두 성공 |
| Poppler 표시 | 정상 → 뷰어 간 결과 불일치 |

- 원인(추정): `addFont` 가 만든 `CIDFontType0` 에서 콘텐츠의 2바이트 코드는 glyph id 인데, MuPDF 는 이를 CID 로 보고 CID-keyed CFF charset 으로 다시 매핑한다. ToUnicode 는 같은 코드 기준이라 추출은 맞는다.
- 조치: 폴백 폰트를 glyf(TrueType) 서브셋으로 교체. Google Fonts Noto Sans KR 가변 TTF → `wght=400` 정적 인스턴스 → 한글 음절 11,172자·호환 자모·라틴·기본 기호 서브셋. 2,556,960 B / 12,267 글리프(`assets/fonts/README.md`, 생성 스크립트 `scripts/fonts/build-noto-sans-kr-subset.sh`, 재생성 해시 동일 확인).
- `tools/spike-m0/test/spike.test.ts` 에 이 실패를 대조 테스트로 둔다(원본 OTF 가 `assets/fonts/src/` 에 있을 때만 실행). MuPDF 동작이 바뀌면 이 테스트가 실패한다.

### 6.4 대조: 증분 저장

| 조건 | `canBeSavedIncrementally()` | `saveToBuffer('incremental')` | 비고 |
|---|---|---|---|
| redaction 직후 | `false` | **예외 없이 성공**(12,629 B) | 출력 앞 11,674 B 가 원본과 바이트 단위 동일 → 제거한 문단이 이전 리비전에 그대로 남음 |
| 주석 1개만 추가 | `true` | 성공, 783 B 추가 | `decideSaveMethod` → 증분 |

- `canBeSavedIncrementally()` 는 권고값이고 MuPDF 는 증분 저장을 막지 않는다. 저장 방식은 앱(`pdf-ops` `decideSaveMethod`)이 강제한다. 텍스트·스트림 교체는 redaction 유무와 무관하게 전체 저장으로 둔다(이전 리비전 원문 잔존 방지).

### 6.5 합성 대형 문서 벤치마크(서버 Node, 참고치)

샘플 페이지 N장 + 페이지마다 압축 불가 잡음 이미지(512×512 RGB). 1쪽 문단 교체(6.1 과 같은 편집) 후 전체 저장, 대조로 주석 1개 추가 후 증분 저장.

| 문서 | 크기 | 열기 | 전체 저장 | 증분 저장(대조) | WASM 힙: 열기 후 → 전체 저장 후 / 증분 저장 후 | maxRSS 전체 / 증분 |
|---|---|---|---|---|---|---|
| 100쪽 | 79,631,356 B (75.9 MiB) | 169 ms | subset 13.3 + save 135.6 ms | 100.8 ms | 98.9 → **340.6 MiB (파일의 4.48배)** / 301.9 MiB (3.98배) | 556.2 / 575.8 MiB |
| 300쪽 | 238,508,962 B (227.5 MiB) | 474 ms | subset 20.4 + save 298.7 ms | 344.2 ms | 280.8 → **648.3 MiB (2.85배)** / 797.1 MiB (3.50배) | 1,194.7 / 1,549.1 MiB |

- 열기만으로 파일 크기의 약 1.2–1.3배가 WASM 힙에 올라간다(입력 바이트 복사). `saveToBuffer` 는 출력 전체를 WASM 메모리 버퍼로 만든다.
- 저장 후 WASM 힙은 파일 크기의 2.9–4.5배. WASM 힙 상한 2 GiB 기준 단순 환산 시 전체 저장 가능 문서는 약 450–700 MB 이하(합성 문서 기준 추정, 실제 코퍼스 미측정).
- 같은 100쪽 문서를 서버 헤드리스 Chromium 156 Worker 에서 "전체 저장 측정"(편집 없음, `garbage=compact,compress`): 수신 231 ms, 열기 75 ms, 1쪽 렌더 28 ms, 전체 저장 185.6 ms, WASM 힙 340.3 MiB(356,777,984 B). Node 측정과 같은 수준.
- 서버 수치이며 Windows Chrome 수치가 아니다. 기준 PC 조건 수치는 9.3 V4 에서 측정한다.

## 7. 문제·결정 사항

| # | 내용 | 처리 |
|---|---|---|
| P1 | CFF OTF 폴백 폰트가 MuPDF 1.28.1 `addFont` 경로에서 표시 실패·서브셋 실패(6.3) | glyf TTF 서브셋으로 교체. PLAN.md 의 결정("Noto Sans KR 서브셋을 `new Font` + `addFont` 로 실제 임베딩, `addCJKFont` 미사용")은 유지. PLAN.md 2절 "서브셋 OTF" 표기와 용량(문서 기준 1.8MB → 실측 2.56MB) 갱신 필요 — 이번 작업에서 PLAN.md 는 수정하지 않음 → 2026-10-18 PLAN.md v2.1 2절에 반영 완료 |
| P2 | `canBeSavedIncrementally()=false` 여도 증분 저장이 실행되고 원문이 남음(6.4) | `decideSaveMethod` 로 강제. 텍스트·스트림 교체는 항상 전체 저장 |
| P3 | 전체 저장 피크 WASM 힙이 파일 크기의 2.9–4.5배(6.5) | 대형 문서 상한·저장 경로(스트리밍 쓰기 가능 여부) M0 후속 검토 → 조사 완료 2026-10-18(`docs/m0-dod-xobject-redact-save.md` 3절): 출력 스트리밍 불가, 입력 Stream 열기 채택(M1, A3-1), 예상 피크 힙 경고 구현. PLAN.md v2.2 3.1·5.4 반영 |
| P4 | module Worker 첫 메시지 유실(4절) | 수정 완료 |
| P5 | WASM 힙 측정은 `$libmupdf_wasm_Module` 설정 객체로 emscripten `HEAPU8` 를 읽는다. core 보다 먼저 `mupdf` 를 import 하면 측정값 `null` | 진입점·테스트 import 순서 고정, 주석 명시 |
| P6 | 페이지 단위 `applyRedactions()` 는 문서에 원래 있던 Redact 주석까지 적용 | 새 주석만 주석 단위 `applyRedaction()` 으로 적용, 기존 Redact 주석 수 보고 |
| P7 | 최상위 MIME handler 도 하위 프레임(`window.top !== window`)이다(5.2) | 문맥 구분은 `StreamInfo.embedded` 로 한다. FSA 교차 출처 제한 여부는 Windows 9.4 결과로 확정 → 2026-10-19 Windows Chrome 155: 세 문맥 모두 FSA 선택기 동작, 임베디드 문맥 교차 출처 SecurityError 는 사용자 보고상 없음(진단 JSON 미수신, 9.4) |
| P8 | `@types/chrome` DNR 열거형은 ambient enum 이라 Chrome 밖에서 값이 없다 | 규칙은 문자열 리터럴로 만들고 타입만 맞춤 |

## 8. Action Items

| # | 내용 | 담당 | 근거 |
|---|---|---|---|
| A1 | 9절 Windows 체크리스트 수행, 결과 칸 기입(Chrome 버전 포함, PLAN.md 11절 "사용자 기입" 칸 동시 갱신). **2026-10-19 1차 완료**(Chrome 155): G1·G2, I1·I2·I3·I5·I6, R1·R2, V1, F1·F2 기입, PLAN.md 11절 갱신(v2.3). 미확인 잔여: 임베디드 문맥 F3 의 Ctrl+S 재저장·fsaError, F1·F3 진단 JSON, I2 파일 URL 접근 설정 상태, F2 권한 재요청 여부, I4, I7(→A5), V2, V3, V4(→A3-4) | 사용자 | 2·3·5번 Windows 검증. 결과 9.5 |
| A2 | PLAN.md 2절 폴백 폰트 표기 갱신: "서브셋 OTF, 문서 기준 1.8MB" → "glyf TTF 서브셋, 실측 2,556,960 B" **완료 2026-10-18**(PLAN.md v2.1, P1 사유 포함) | 메인 세션(완료) | P1 |
| A3 | 브라우저(Windows Chrome Worker) 전체 저장 피크 메모리·시간 측정, 벤치마크 문서 세트·기준 PC 조건 확정 — 서버 측정 완료(Node·헤드리스 Chromium 156, `docs/m0-dod-xobject-redact-save.md` 3.3). Windows Chrome 측정은 미확인(9.3 V4, A3-4) | M0 후속 | PLAN.md 3.1, 8절 |
| A4 | 대형 문서 저장 정책: 저장 전 예상 WASM 힙(파일 크기 × 실측 배율) 계산·경고, 출력 스트리밍 쓰기 가능 여부 조사 **완료 2026-10-18**(`docs/m0-dod-xobject-redact-save.md` 3절: 스트리밍 불가, 예상 피크 힙 경고 구현. PLAN.md v2.2 3.1·5.4) | M0 후속(완료) | P3 |
| A5 | Chrome 128–150 DNR 경로 실측 수단 확보(구버전 Chrome for Testing 설치 후 Playwright 자동화 또는 별도 PC) | M0 후속 | PLAN.md 5.1 |
| A6 | M0 DoD 중 Day 1 범위 밖 항목: 공유 Form XObject 복제 정책, 기존 Redact 주석 문서 처리 UI, 표 셀 교체 **부분 완료 2026-10-18**: 공유 Form XObject 복제 정책·기존 Redact 주석 처리 정책 통과(`docs/m0-dod-xobject-redact-save.md` 1·2절, PLAN.md v2.2 1.3·3.1·3.4). Redact 처리 UI 는 M3(A2-2). 표 셀 교체는 M0 DoD 항목이 아니며 PLAN.md 6절 M4 범위 | M0 후속 | PLAN.md 6절 |
| A7 | 코퍼스 `fixtures/` 수집(한글 논문·표 중심 재무 문서 등)과 실제 문서 스파이크 재실행 | M0 후속 | PLAN.md 8절 |
| A8 | 폴백 폰트 배포 용량 검토(현재 2.56 MB 원본, brotli 미측정). 축소안(KS X 1001 2,350자) 비교는 선택 | M5 전 | P1 |
| A9 | 편집 문단의 읽기·복사 순서(2026-10-19 W1): 스파이크 결과 파일의 전체 복사가 제목 → 인접 영어 문단 → 꼬리말 → 한글 문단 순으로, 화면 순서(제목 → 한글 문단 → 인접 문단 → 꼬리말)와 다르다(사용자 보고). 같은 파일을 pypdfium2 5.14.0(PDFium 156.0.8076.0)으로 추출해도 같은 순서(측정)라 확장 뷰어 결함이 아니라 파일의 성질이다: 스파이크가 새 문단을 쪽 콘텐츠 끝에 덧붙인다. 확장을 끈 Chrome 기본 뷰어에서의 직접 복사 순서는 미확인. 제품에서는 편집한 문단이 복사·읽기 순서에서 원래 자리가 아니라 쪽 끝에 나온다. 새 텍스트 연산을 지운 문단의 원래 위치(SourceMap 의 연산 바이트 위치)에 끼워 넣는 방식을 M3 설계 항목으로 둔다. PLAN.md 1.4 태그 정책 2번("편집 영역의 읽기 순서·구조 연결은 v1 에서 갱신하지 않음")은 구조 트리 기준이며, 태그 없는 문서의 읽기 순서는 콘텐츠 순서로 정해지므로 이 항목은 그 정책과 별개로 필요하다. PLAN.md 본문 범위는 바꾸지 않았다 | M3 설계 | 9절 2차 W1 |
| A10 | 임베디드 문맥 Ctrl+S 덮어쓰기 재확인(2026-10-19 W5 조건부 통과): 같은 대상 재저장 시 진단 JSON 의 `save.channel`·`reusedHandle`·`fsaError` 와 파일 수정 시각·해시 변화를 함께 기록한다. 편집 없는 문서는 내용이 같아 해시로 구분되지 않으므로 M3 편집 기능 이후 편집한 문서로 확인한다 | 사용자(M3 이후) | 9.4 F3 |
| A11 | 2026-10-19 W1 미확인 항목 재확인: 영어 검색어 `paragraph` 결과 건수(PDFium 직접 측정 기대값 대소문자 무시 3건·구분 2건), 하이라이트 위치, Enter 순환 | 사용자 | 9절 2차 W1 |

## 9. Windows 확인 체크리스트

결과 칸에 O/X 와 관찰 내용을 적는다. 각 항목 후 뷰어 "진단 결과 복사" JSON 을 붙여 두면 원인 분석에 쓴다.

### 9.0 준비

1. 기존 복사본이 있으면 먼저 지운다(scp 는 기존 폴더 안에 `dist` 를 하나 더 만든다).
   ```powershell
   Remove-Item -Recurse -Force C:\Users\harry\pdf-editor-dist
   ```
2. 복사:
   ```powershell
   scp -r Mustree:/mnt/nas4/kjune/pdf-editor/apps/extension/dist C:\Users\harry\pdf-editor-dist
   ```
3. `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램 로드" → `C:\Users\harry\pdf-editor-dist`.
4. `chrome://version` 의 버전을 기록한다. 가로채기 경로는 뷰어 진단 `env.interceptionMode`·`env.dynamicRuleIds` 로 확인한다.
5. http 임베드 확인용 로컬 서버(Node 24 사용):
   ```powershell
   npx --yes http-server@14.1.1 C:\Users\harry\pdf-editor-dist\diag -p 8000
   ```

| # | 항목 | 결과 |
|---|---|---|
| G1 | Chrome 버전(`chrome://version`) | 통과. Chrome 155.0.8059.82 공식 빌드 64비트 (측정: 진단 JSON `env`, 2026-10-19 KST) |
| G2 | 뷰어 진단 `env.interceptionMode`(151+ 기대값 `mime-handler`, `dynamicRuleIds` 빈 배열) | 통과. `hasMimeHandlerApi` true, `interceptionMode` "mime-handler", `dynamicRuleIds` [], `hasShowSaveFilePicker` true, `hasDownloadsApi` true (측정: 진단 JSON `env`) |
| G3 | Chrome 128–150 환경 유무(있으면 9.1 I7 수행) | 해당 없음. 이 PC 는 Chrome 155 라 128–150 환경 없음 → I7 미수행, A5 유지 |

### 9.1 가로채기(세 문맥 + file://)

| # | 절차 | 기대 | 결과 |
|---|---|---|---|
| I1 | 공개 https PDF 주소로 이동(예: 임의의 웹 PDF 링크) | 배지 `mime-handler-top`, 1쪽 렌더 | 통과. https PDF 2개(mozilla.github.io tracemonkey, w3.org dummy.pdf) 확장 뷰어로 열림, 배지 `mime-handler-top` (사용자 보고) |
| I2 | `C:\Users\harry\pdf-editor-dist\diag\m0-sample.pdf` 를 주소창에 입력(“파일 URL에 대한 액세스 허용” **끔** 상태) | 배지 `mime-handler-top`, 렌더(파일 URL 설정 불필요) | 통과. kind `mime-handler-top`, `streamInfo.embedded` false, byteLength 11674, fetchMs 2.4, openMs 6.1, renderMs 45.2(scale 3) (측정: 진단 JSON). "파일 URL에 대한 액세스 허용" 이 꺼져 있었는지는 **설정 상태 미확인** |
| I3 | `file:///C:/Users/harry/pdf-editor-dist/diag/embed-test.html` | embed·iframe·object 3개 모두 배지 `mime-handler-embedded`, 렌더 | 통과. embed·iframe·object 3개 모두 배지 `mime-handler-embedded` 로 렌더 (사용자 보고 + 측정: 사용자가 이 페이지를 PDF 로 인쇄한 "M0 임베디드 문맥 테스트.pdf" 의 텍스트에서 배지 3개 확인) |
| I4 | `http://localhost:8000/embed-test.html` (9.0-5 서버) | I3 과 동일 | 미확인. 로컬 http 서버 미실행(선택 항목) |
| I5 | `C:\Users\harry\pdf-editor-dist\diag\not-a-pdf.pdf` | 확장 뷰어가 Chrome 기본 PDF 뷰어로 넘어감(오류 화면) | 통과. Chrome 기본 PDF 뷰어의 "PDF 문서를 로드하지 못했습니다." 표시 (사용자 보고). 확장 소스(`apps/extension/src`)에 이 문구가 없고 `abortAndFallbackToNativeHandler` 호출만 `viewer/main.ts` 에 있음(측정) → 기본 뷰어 전환으로 판정. 주소창에 원래 file:// 주소가 남는 것은 MIME handler 의 정상 동작이므로 판정 근거로 쓰지 않음 |
| I6 | 확장 아이콘 클릭 → 뷰어에서 로컬 PDF 선택 | 배지 `viewer-page`, 렌더 | 통과. 배지 `viewer-page`, 렌더 (사용자 보고). 진단 JSON 없음 |
| I7 | (Chrome 128–150 에서만) I1·I2 반복. I2 는 “파일 URL에 대한 액세스 허용” 끔/켬 각각 | 배지 `url-param`(DNR 리다이렉트), 렌더. file:// 결과는 그대로 기록 | 미확인. 이 PC 는 Chrome 155 → A5(구버전 실측 수단) 로 유지 |

### 9.2 렌더

| # | 절차 | 기대 | 결과 |
|---|---|---|---|
| R1 | I1–I4, I6 각 문맥의 캔버스 | 페이지 표시, 흐림·깨짐 없음, 진단 `render.renderMs` 기록 | 통과 (사용자 보고). `renderMs` 는 I2 의 45.2 ms(scale 3)만 측정, 다른 문맥의 수치는 진단 JSON 미수신 |
| R2 | `diag\m0-spike-saved.pdf` 를 확장 뷰어로 열기 | 한글 문단 정상 표시 | 통과. 한글 문단·배경·이미지·꼬리말 정상 (사용자 스크린샷, 확장 뷰어) |

### 9.3 스파이크 결과 파일: 다른 뷰어 표시·검색·복사

대상: `C:\Users\harry\pdf-editor-dist\diag\m0-spike-saved.pdf` (서버 출력과 같은 sha256 `58b19a53…f468`).

| # | 뷰어 | 확인 | 결과 |
|---|---|---|---|
| V1 | Chrome 기본 뷰어(확장 끈 상태 또는 다른 프로필) | 한글 문단 표시, 배경·괘선·이미지 유지, Ctrl+F `폴백 폰트` 검색, 문단 복사 → 메모장 붙여넣기 일치 | 통과. `m0-spike-saved.pdf`·`m0-shared-xobject-edited.pdf`·`m0-preexisting-redact-edited.pdf` 3개 표시 정상 (사용자 스크린샷, 확장 끈 상태). shared-xobject: 위 카드 원문 유지, 아래 카드·중첩 배지만 한글 교체, 제목·세로 괘선·꼬리말 유지. preexisting-redact: Redact 상자 2개와 메모 아이콘 유지, R2 상자가 교체 한글 첫 줄과 겹침(정책 초안의 warn 시나리오와 일치). 검색·복사: 확장을 끈 Chrome 기본 뷰어에서 가능 (사용자 보고, 파일·검색어 세부 기록 없음). 독립 측정: PDFium(Python pypdfium2 5.14.0, PDFium 156.0.8076.0, 2026-10-19)으로 3개 파일 추출·검색 → 한글 문단 전문이 정확히 추출되고 한글 검색어가 교체한 쪽에서만 1건씩 검색. 이 수치는 Chrome 155 자체가 아닌 PDFium 156 빌드 결과이며, 스크립트는 저장소에 없고 사용자 PC 임시 폴더에 있음 |
| V2 | Acrobat Reader(설치 시) | V1 과 동일 + 문서 속성 › 글꼴: `NotoSansKR` "포함된 하위 집합" | 미확인. Acrobat 미실행. A2-5 의 "Acrobat 이 Redact 를 적용 대기로 표시하는지" 도 미확인. **2차(2026-10-19, W7): 미확인** — 이 PC 에 Acrobat Reader 가 설치되어 있지 않다 |
| V3 | pdf.js(Firefox 또는 https://mozilla.github.io/pdf.js/web/viewer.html 에 파일 끌어놓기) | V1 과 동일 | 미확인. pdf.js 미실행 |
| V4 | 확장 뷰어에서 큰 PDF(100쪽 이상 실제 문서) 열기 → 진단 "전체 저장 측정" | 진단 `bench-full-save.saveMs`, `wasmHeapBytes`, 문서 크기·쪽수, PC 사양(CPU·RAM) 기록 | 미확인. 대형 문서 전체 저장 측정 미실행(A3-4 와 함께). **2차(2026-10-19, W6): 부분 측정** — nist-sp800-53r5 492쪽 saveMs 219.2·wasmHeapBytes 69,140,480·출력 11,711,450 B, nasa-se-handbook 297쪽 349.2·85,196,800·23,112,140 B(측정, 진단 JSON 각 1회). PC 사양·반복 측정 미확인. 세부·출력 크기 원인은 `docs/m0-dod-xobject-redact-save.md` 3.3 |

### 9.4 FSA·downloads(세 문맥)

각 문맥(F1 일반 뷰어 페이지 = I6, F2 최상위 MIME handler = I2, F3 임베디드 = I3 의 embed 프레임)에서 순서대로 수행한다.

| 단계 | 절차 | 기록 |
|---|---|---|
| 1 | "다른 이름으로 저장" | 저장 대화상자 종류(FSA 파일 선택기 / Chrome 다운로드 "다른 이름으로 저장"), 진단 `save.channel`·`fsaError` |
| 2 | 대화상자에서 새 파일로 저장 | 파일 생성 여부 |
| 3 | Ctrl+S | 상태 표시 "(같은 대상 재저장)" 여부, 탐색기에서 같은 파일의 수정 시각 변경·새 파일 미생성 |
| 4 | 탭을 닫지 않고 다시 Ctrl+S | 권한 재요청 대화상자 여부 |
| 5 | "downloads 저장" | 다운로드 "다른 이름으로 저장" 대화상자, 파일 생성 |

| 문맥 | 1 대화상자 / channel / fsaError | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| F1 일반 뷰어 페이지 | FSA 선택기 정상 (사용자 보고). 진단 JSON 미수신 → channel·fsaError 미확인 | 파일 생성 (사용자 보고) | 같은 대상 재저장 정상 (사용자 보고) | 정상 (사용자 보고. 권한 재요청 창 여부의 세부 기록 없음) | downloads 저장 정상 (사용자 보고) |
| F2 최상위 MIME handler | FSA 선택기 정상, channel `fsa`, fsaError null (측정: 진단 JSON). 선택기를 닫은 2회는 status `cancelled` 이며 downloads 로 넘어가지 않음 | `saved`: test1.pdf, bytes 11674(선택기 사용 9.9초 포함) (측정). 디스크: `C:\Users\harry\Downloads\test1.pdf` 11,674 B, SHA-256 이 원본 m0-sample.pdf 와 동일(913C521A…5144, 편집이 없었으므로 정상), 수정 시각 = 마지막 저장 시각 (측정). worker-save method `incremental`(편집 없음 + canBeSavedIncrementally true) | Ctrl+S: `reusedHandle` true, 238 ms, 선택기 없이 `saved` (측정: 진단 JSON) | 미확인(추정). 두 번째 Ctrl+S 가 238 ms 였으므로 권한 재요청 창은 뜨지 않은 것으로 보이나 사용자에게 직접 확인받지 못함 | "저장됨: chrome.downloads" 표시 (사용자 보고), Downloads 에 m0-sample.pdf 11,674 B 생성 (측정) |
| F3 임베디드 MIME handler | FSA "다른 이름으로 저장" 선택기 정상 (사용자 보고. OS 의 덮어쓰기 확인 창은 선택기 기본 동작). 진단 JSON 미수신 → fsaError 값 미확인 | 파일 저장 (사용자 보고) | 미확인. Ctrl+S 가 같은 대상에 덮어썼는지 확인 못 함. **2차(2026-10-19, W5): 조건부 통과** — 다른 이름으로 저장(w5-test.pdf) 후 Ctrl+S 에 상태 표시 "저장됨: 파일 w5-test.pdf (같은 대상 재저장)", 새 파일 미생성(사용자 보고). `C:\Users\harry\Downloads\w5-test.pdf` 11,674 B 한 개, 생성 18:24:55·수정 18:24:56, 18:25:22·18:27:17 재확인 시 불변(측정). 두 번째 쓰기가 수정 시각으로 확인되지 않아 실제 덮어쓰기는 미확인(F2 의 test1.pdf 는 재저장 시각이 반영됐었다) | 미확인. 2차(W5)에도 권한 재요청 여부 기록 없음 | downloads 저장 정상. 같은 이름이 있어 `m0-sample (1).pdf` 로 자동 번호(conflictAction uniquify 동작과 일치) (사용자 보고) |

- 기록 주의: 사용자가 처음 "F1" 로 보고한 진단 JSON 은 문맥이 `mime-handler-top`(file:// 직접 열기)이므로 **F2** 로 기록했다. 이 표의 "임베디드 문맥 F3" 은 `docs/m0-dod-xobject-redact-save.md` 의 "MuPDF 결함 F3"(이미지 `resolve()` + compact 저장) 과 이름만 같은 다른 항목이다.
- 결론(2026-10-19): **세 문맥 모두 FSA 선택기와 downloads 저장 동작.** 임베디드 문맥 F3 에서 교차 출처 SecurityError 는 사용자 보고상 발생하지 않음(진단 JSON 미수신). 임베디드 문맥 F3 의 Ctrl+S 재저장은 미확인.

- 기대(서버 헤드리스 결과 기준): 세 문맥 모두 FSA 선택기 표시. F2·F3 에서 SecurityError 가 나오면 downloads 로 넘어가며 그 사실이 `fsaError` 에 남는다.
- downloads 경로는 매번 새 파일이며 같은 대상 재저장이 아니다.

### 9.5 검증 요약 (2026-10-19 KST)

| 항목 | 내용 |
|---|---|
| 검증 환경 | Windows PC, Chrome 155.0.8059.82 공식 빌드 64비트(측정). 진단 JSON 의 UTC 시각은 2026-10-18T19:0x(= 2026-10-19 KST 새벽). 가로채기 경로 MIME handler, DNR 동적 규칙 0개 |
| 근거 표기 | "사용자 보고" = 사용자가 눈으로 확인한 것, "측정" = Windows PC 의 파일·로그·진단 JSON 에서 직접 확인한 것, "화면 판독" = 스크린샷을 보고 판단한 것(정답 라벨과 대조 아님, 2차부터), "미확인" = 수행하지 않았거나 근거를 받지 못한 것 |
| 통과 | G1·G2, I1·I2·I3·I5·I6, R1·R2, V1, F1(사용자 보고)·F2(측정)·F3 의 1·2·5 단계 |
| 미확인 | 임베디드 문맥 F3 의 Ctrl+S 재저장(3·4 단계)과 fsaError 값, F1·F3 진단 JSON, I2 "파일 URL에 대한 액세스 허용" 설정 상태, F2 권한 재요청 창 여부(추정만), I4(로컬 http 임베드), I7(Chrome 128–150 DNR → A5), V2(Acrobat, A2-5 포함), V3(pdf.js), V4(대형 문서 브라우저 측정 → A3-4) |
| 해당 없음 | G3(이 PC 에 Chrome 128–150 없음) |
| 2차 확인(2026-10-19 KST, W1–W8) | 확인 빌드 `m2` 110549f dist, Chrome 155.0.8059.82. 통과(사용자 보고): W1 텍스트 선택·복사·한글 검색(F1·F2·F3), W2 object 포커스, W3 여러 임베디드 뷰어. 조건부 통과: W5 임베디드 Ctrl+S(덮어쓰기 미확인). 부분 측정: W6 대형 문서 저장. 화면 판독: W4 레이아웃 오버레이. 미확인: W7(Acrobat 미설치), W8(Chrome 128–149 없음). 추적: U1–U4 `docs/m0-closeout.md` 3절, U5–U7 `docs/m1-integration.md` 3절, W4 `docs/m2-accuracy.md` 7절, 새 Action Item 은 8절 A9–A11 |

알려진 한계(코드 미수정, PLAN.md 미반영, 사용자 결정 대기)
- 확장 뷰어는 페이지를 캔버스 이미지로만 그리므로 **확장이 켜진 상태에서는 Ctrl+F 검색과 텍스트 선택·복사가 되지 않는다.** 확장 소스에 텍스트 선택 층 코드가 없음을 grep 으로 확인(측정). 사용자 보고로도 "확장 끄면 가능, 켜면 불가". 텍스트 선택 층·Ctrl+F 를 M1 에 추가할지는 사용자 결정 대기(PLAN.md 에는 반영하지 않음).
