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
| 2 | manifest·viewer·Worker, 세 문맥 가로채기 | 코드 완료 | 필요(9.1) |
| 3 | Worker 1페이지 렌더 → 캔버스 | 완료 | 필요(9.2) |
| 4 | 스파이크(redaction → 한글 임베딩 → 전체 저장 → 재열기·검색) | 완료, 통과 | 다른 뷰어 표시 확인 필요(9.3) |
| 5 | FSA 세 문맥·downloads 폴백·Playwright | 5절 참조 | 필요(9.4) |

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
- Playwright 번들 Chromium 156(headless) 임시 확인: `viewer.html?file=http://…` 렌더 완료, http PDF 직접 이동 시 MIME handler 가 `viewer.html` 프레임으로 가로채 렌더 완료. 자동 테스트는 5절.

## 5. 체크리스트 5: FSA·downloads·Playwright

(5단계 커밋에서 기록)

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
- 서버 Node 수치이며 Windows Chrome Worker 수치가 아니다. 기준 PC 조건 수치는 9.3 에서 측정한다.

## 7. 문제·결정 사항

| # | 내용 | 처리 |
|---|---|---|
| P1 | CFF OTF 폴백 폰트가 MuPDF 1.28.1 `addFont` 경로에서 표시 실패·서브셋 실패(6.3) | glyf TTF 서브셋으로 교체. PLAN.md 의 결정("Noto Sans KR 서브셋을 `new Font` + `addFont` 로 실제 임베딩, `addCJKFont` 미사용")은 유지. PLAN.md 2절 "서브셋 OTF" 표기와 용량(문서 기준 1.8MB → 실측 2.56MB) 갱신 필요 — 이번 작업에서 PLAN.md 는 수정하지 않음 |
| P2 | `canBeSavedIncrementally()=false` 여도 증분 저장이 실행되고 원문이 남음(6.4) | `decideSaveMethod` 로 강제. 텍스트·스트림 교체는 항상 전체 저장 |
| P3 | 전체 저장 피크 WASM 힙이 파일 크기의 2.9–4.5배(6.5) | 대형 문서 상한·저장 경로(스트리밍 쓰기 가능 여부) M0 후속 검토 |
| P4 | module Worker 첫 메시지 유실(4절) | 수정 완료 |
| P5 | WASM 힙 측정은 `$libmupdf_wasm_Module` 설정 객체로 emscripten `HEAPU8` 를 읽는다. core 보다 먼저 `mupdf` 를 import 하면 측정값 `null` | 진입점·테스트 import 순서 고정, 주석 명시 |
| P6 | 페이지 단위 `applyRedactions()` 는 문서에 원래 있던 Redact 주석까지 적용 | 새 주석만 주석 단위 `applyRedaction()` 으로 적용, 기존 Redact 주석 수 보고 |

## 8. Action Items

(5단계 커밋에서 기록)

## 9. Windows 확인 체크리스트

(5단계 커밋에서 기록)
