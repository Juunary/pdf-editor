# M5 배포 패키지·안내 UI (작업 S3)

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-21 |
| 브랜치 | `m5-release` (기준 `m5` 6e4f3b2, worktree `/mnt/nas4/kjune/pdf-editor-m5-release`) |
| 범위 | `docs/m5-contract.md` 4.3·D6·D7 |
| 상태 | 구현·시험 완료(10절 툴바 수정 포함). 매니페스트 이름·설명·버전 값은 메인 세션 승인 대기(5절) |

## 1. 요약

- Web Store 용 빌드 종류(`store`)를 개발 빌드(`dev`, `dist/`)와 분리했습니다(D7 (a)).
- `pnpm --filter @pdf-editor/extension package` 한 번으로 스토어 빌드 → 스테이징 → 결정적 zip → `verify-dist --release` 까지 실행합니다.
- 결과: `apps/extension/out/release/pdf-editor-1.0.0.zip` 7,149,912 B(6.82 MiB). 같은 입력에서 두 번 만든 zip 의 sha256 이 같았습니다.
- 정보 대화상자, 지원 크기·저널·되돌리기 소실 안내, 진단 UI 숨김, 아이콘, `THIRD_PARTY_NOTICES.txt` 를 갖췄습니다.

## 2. 빌드 종류

| 항목 | `dev` (기본, `dist/`) | `store` (`out/release/build`) |
| --- | --- | --- |
| 선택 | `vite build` | `PDF_EDITOR_BUILD=store vite build`(package 가 설정) |
| 이름 | `PDF Editor (dev)` | `PDF Editor` |
| 버전 | `apps/extension/package.json` `version`(1.0.0) | 같음 |
| 최소 Chrome | 128 | 151 |
| 권한 | `declarativeNetRequestWithHostAccess`, `downloads` | `downloads` |
| `host_permissions` | `<all_urls>` | 없음 |
| `web_accessible_resources` | `viewer.html` (`<all_urls>`) | 없음 |
| 서비스 워커 | DNR 폴백 규칙 등록(128–150) | `chrome.declarativeNetRequest` 가 없으면 규칙 관리 생략 |
| 소스맵 | 일반(`sourceMappingURL` 포함) | `hidden`(번들에 참조 없음) |
| 진단 UI | 보임 | CSS 로만 숨김(`html[data-build='store']`) |
| `diag/` 자산 | 포함 | build 에는 있으나 스테이징에서 제외 |

- 매니페스트 기준 파일은 `apps/extension/manifest.json`(`public/` 에서 이동)입니다. `scripts/manifest.mjs` 의 `buildManifest(base, kind, version)` 가 종류별로 만들고 vite 플러그인이 `manifest.json` 을 출력합니다. 권한 값은 기준 파일에서 빼기만 하며 새 권한을 더하지 않았습니다.
- 계약 D6 은 "`dist` 에서 `diag/`·`*.map` 을 뺀 스테이징" 으로 적었으나, 스토어 매니페스트(D7)와 hidden 소스맵이 `dist` 와 달라 스토어 빌드를 별도 디렉터리(`out/release/build`)에 만들고 거기서 스테이징합니다. `dist` 는 변하지 않습니다.
- `package.json` 단일 출처 버전이 `manifest.json`·빌드 정의(`__APP_VERSION__`)·zip 이름·고지·`verify-dist` 검사에 쓰입니다.

## 3. 패키지 절차

```bash
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter='@pdf-editor/extension^...'   # core·viewer-ui·shared-types 빌드(turbo build 가 이미 돌았으면 생략)
pnpm --filter @pdf-editor/extension package
```

산출물(`apps/extension/out/release/`, git 제외):

| 경로 | 내용 |
| --- | --- |
| `build/` | vite 스토어 빌드(맵 포함) |
| `staging/` | 배포 내용: `build/` 에서 `diag/`·`*.map` 제외 + `LICENSE` + `THIRD_PARTY_NOTICES.txt` |
| `maps/` | 소스맵(`build/` 에서 분리) |
| `pdf-editor-<version>.zip` | Web Store 업로드 파일(스테이징 내용) |
| `pdf-editor-<version>-sourcemaps.zip` | 소스맵 묶음. zip 에 넣지 않고 릴리스 자산으로 보관 |
| `sizes.json` | 자산별 원본·gzip·brotli 크기 |

- zip 은 `fflate` 로 만듭니다. 항목은 경로순, 항목 시각은 2000-01-01 00:00(지역 시각)으로 고정, 압축 수준 9입니다.
- `verify-dist --release`(package 끝에서 자동 실행, 단독 실행: `node scripts/verify-dist.mjs --release`)가 확인하는 것:
  - 개발 파일 부재: `diag/`, `*.map`, `sourceMappingURL`, 진단 자산 참조
  - 스토어 매니페스트: 이름, 버전 = `package.json`, 최소 Chrome 151, 권한 `downloads` 만, 호스트 권한·WAR 없음, 아이콘 16·32·48·128 파일, `action.default_icon`
  - 공통: MuPDF·harfbuzz WASM 해시, 폴백 폰트 해시, MuPDF·harfbuzz 코드가 Worker 청크에만 있음
  - `LICENSE`·`THIRD_PARTY_NOTICES.txt` 존재, 고지에 mupdf·harfbuzzjs·preact·comlink·Noto Sans KR·Copyright 포함, 개발 의존성 미포함
  - 폴백 폰트 `name` 표에 예약 이름 `Source` 가 글꼴 이름 항목에 없음
  - 크기 상한: 압축 전 합계 25 MiB, zip 15 MiB
  - zip 항목·바이트가 스테이징과 같고, 같은 스테이징에서 zip 이 같은 바이트로 재생성됨
- 스테이징 스모크 e2e(`e2e/release-smoke.spec.ts`)는 `pnpm run package` 를 실행한 뒤 스테이징을 압축해제 확장으로 로드합니다. `pnpm exec turbo run test:e2e` 에 포함되며 단독 실행은 `pnpm --filter @pdf-editor/extension exec playwright test e2e/release-smoke.spec.ts` 입니다. 확인 항목:
  - 서비스 워커: 스토어 매니페스트, `chrome.declarativeNetRequest` 없음, `chrome.mimeHandler` 있음
  - http 로 제공한 PDF 의 최상위 MIME handler 열기·렌더(캔버스 잉크)·`chrome.downloads` 저장(원본과 같은 바이트 수)
  - 진단 패널·벤치 버튼·downloads 저장 버튼이 DOM 에 있으나 보이지 않음
  - 정보 대화상자: 버전, AGPL, `/tree/v1.0.0` 소스 링크, 고지 파일 링크와 내용
  - 웹 페이지가 `viewer.html?file=` 을 iframe 으로 띄우면 차단됨(오류 프레임)

## 4. 크기

기준: 스테이징 15,671,330 B(14.95 MiB, 상한 25 MiB), zip 7,149,912 B(6.82 MiB, 상한 15 MiB), 소스맵 zip 594,968 B.

| 자산 | 원본 B | gzip B | brotli B |
| --- | --- | --- | --- |
| `mupdf-wasm-*.wasm` | 10,409,826 | 4,750,407 | 3,622,011 |
| `NotoSansKR-Regular-subset-*.ttf` | 4,082,236 | 1,863,953 | 1,518,806 |
| `harfbuzz-*.wasm` | 433,766 | 176,751 | 144,353 |
| `session-*.js`(core·pdf-ops·reflow·MuPDF 글루) | 375,897 | 123,361 | 102,735 |
| `viewer-*.js` | 150,757 | 48,915 | 42,250 |
| `viewer-*.css` | 10,112 | 2,637 | 2,300 |
| 그 밖 JS 8개 합 | 약 10,000 | — | — |

- gzip 은 수준 9, brotli 는 Node `zlib.brotliCompressSync`(품질 11)입니다. 전체 표는 `out/release/sizes.json`.
- 폰트(M3 D12 결정 유지)는 축소하지 않았습니다. zip 에서 폰트는 원본의 약 46% 로 들어갑니다.
- Web Store zip 크기 제한 값은 미확인이며 상한은 자체 기준입니다.

## 5. 서드파티 고지

`THIRD_PARTY_NOTICES.txt` 는 package 가 만듭니다(저장소에는 생성기와 수동 표만 둡니다).

- 번들 JS 패키지: 스토어 빌드 소스맵의 모듈 목록에서 `node_modules` 패키지를 모읍니다. 이번 빌드의 목록은 아래 4개이며 각 패키지의 LICENSE·NOTICE 본문이 실립니다. 개발 의존성(`vite`, `fflate`, `vitest`, `@playwright/test` 등)은 목록에 없고, `verify-dist --release` 와 단위 시험이 이를 확인합니다.

| 패키지 | 버전 | 라이선스 |
| --- | --- | --- |
| comlink | 4.4.2 | Apache-2.0 |
| harfbuzzjs | 1.6.2 | MIT |
| mupdf | 1.28.1 | AGPL-3.0-or-later |
| preact | 10.29.8 | MIT |

- 번들 그래프에 안 보이는 항목은 `scripts/release/third-party-extra.json`(라이선스 원문은 `scripts/release/licenses/`)에 있습니다.

| 항목 | 라이선스 | 근거 |
| --- | --- | --- |
| FreeType | FTL(GPL-2.0 이중 중 FTL 선택) | MuPDF WASM 의 `FT_` 심볼 |
| HarfBuzz(MuPDF 내) | MIT(Old MIT) | `hb_shape` 심볼 |
| jbig2dec | AGPL-3.0-or-later | `jbig2_` 심볼 |
| OpenJPEG | BSD-2-Clause | `opj_` 심볼 |
| Little CMS 2 | MIT | `cmsCreate` 심볼 |
| IJG libjpeg | IJG | JPEG 문자열 |
| zlib | Zlib | inflate·deflate 문자열 |
| Gumbo | Apache-2.0 | `gumbo_` 심볼 |
| cmark-gfm | BSD-2-Clause 외 | `cmark` 문자열 |
| Emscripten·musl 기반 libc | MIT / UIUC | Emscripten 글루 코드 |
| `harfbuzz.wasm`(harfbuzzjs 1.6.2) | MIT(Old MIT) | 패키지 `dist/harfbuzz.wasm` |
| Noto Sans KR 부분집합 | OFL-1.1 | `assets/fonts/OFL.txt` |

- MuPDF 1.28.1 thirdparty 확인 방법:
  - 소스: GitHub 미러 `ArtifexSoftware/mupdf` 1.28.1 태그의 `thirdparty/`(brotli, cmark-gfm, curl, extract, freeglut, freetype, gumbo-parser, harfbuzz, jbig2dec, lcms2, leptonica, libjpeg, mujs, openjpeg, tesseract, zint, zlib, zxing-cpp)와 서브모듈 커밋.
  - 링크 판정: `platform/wasm/tools/build.sh` 의 기본 `FEATURES="brotli=no mujs=no extract=no xps=no svg=no"` 와 설치된 `mupdf-wasm.wasm` 의 문자열 조사. tesseract·leptonica·curl 은 바이너리에 없고, brotli 는 "compression not enabled" 문자열만 있습니다.
  - 라이선스 원문은 각 서브모듈 커밋에서 받았습니다.
- 한계: npm 패키지가 위 기본 `FEATURES` 로 빌드됐다는 직접 근거(빌드 로그)는 없고, 바이너리 문자열이 이와 일치하는 정도로 확인했습니다. 법적 검토는 사람 확인 항목입니다.
- OFL 예약 이름 'Source': 폴백 폰트의 `name` 표에서 글꼴 이름 항목(ID 1·3·4·6·16·17)에 'Source' 가 없습니다(패밀리 `Noto Sans KR`). ID 0 저작권 문자열에만 "with Reserved Font Name 'Source'" 가 있으며, 원 저작권 고지 유지 의무에 따라 그대로 둡니다. 서브셋은 수정본이고 이름은 원 글꼴과 같은 'Noto Sans KR' 입니다. OFL 은 수정본의 이름 변경 요구를 예약 이름이 있을 때 적용하므로, 'Source' 가 아닌 이름을 쓰는 현재 상태는 조건에 부합합니다. 최종 해석은 사람 확인 항목입니다.

## 6. 안내 UI

| 안내 | 위치·조건 | 근거 |
| --- | --- | --- |
| 정보 대화상자 | 툴바 `정보`: 버전, AGPL-3.0-or-later, 소스 링크 `https://github.com/Juunary/pdf-editor/tree/v<version>`, 서드파티 고지 링크(스토어 빌드만), 지원 크기·편집 기록·되돌리기 소실 설명, 현재 문서 저장 예상 메모리 | D6 |
| 지원 크기 | 열기 직후와 저장 전 판정(`planSave`)의 `heap.level` 이 `warn`·`over-limit` 이면 알림 줄에 예상 피크·한계를 표시 | 계약 4.2·PLAN.md 7절 리스크 8 |
| 저널 상한 | 힙이 `ok` 가 아니고 core 가 `heap.journalBytes > 0` 을 주면 "저장 후 다시 열기" 권고(저장 확인 창의 안내, over-limit 이면 중단 문구에 덧붙임) | D4 |
| 새 편집 시작 시 redo 소실 | 되돌린 뒤 문단 편집을 시작하면 "다시 실행 기록이 사라졌습니다" 알림(`edit-controller.ts`) | D9 |
| 복구 뒤 undo 소실 | 이미 있던 복구 알림·저장 재시도 창 문구 유지 | D6(M3) |
| 저장 뒤 | 편집이 있는 문서를 처음 저장하면 "저장 뒤에도 되돌리기는 되지만, 폴백 글꼴 편집을 되돌린 직후 저장하면 다시 실행이 사라질 수 있음" 알림 | M3 D9 수정 4 |
| 버튼 설명 | 되돌리기·다시 실행 버튼 툴팁에 소실 조건 | 같음 |

- 지원 크기 값의 연결부: UI 는 `SaveHeapEstimate` 의 `level`·`estimatedPeakBytes`·`limitBytes`·`journalBytes` 만 읽고 자체 경계값을 갖지 않습니다. S1 이 모델을 바꿔도 UI 변경이 필요 없습니다(`model`·`journalBytes` 는 S1 이 채우면 쓰임).
- 진단 패널(`#diag`)·`downloads 저장` 버튼은 `html[data-build='store']` CSS 로만 숨깁니다(DOM 유지). 벤치 버튼은 진단 패널 안에 있어 함께 숨겨집니다.

## 7. 시험

| 시험 | 내용 |
| --- | --- |
| `apps/extension/test/release.test.ts` | 종류별 매니페스트(dev·store), 기준 불변, 아이콘 크기, 소스 링크, 고지(번들 그래프·개발 의존성 제외·수동 표 라이선스 파일 존재), OFL 예약 이름, zip 결정성·정렬, 크기 측정 |
| `apps/extension/test/about.test.ts` | 정보 대화상자 내용, 지원 크기·저널·저장 뒤 안내 문구 |
| `packages/viewer-ui/test/edit-controller.test.ts` | 되돌린 뒤 새 편집 시작 시 redo 소실 안내 |
| `e2e/release-smoke.spec.ts` | 3절 |

## 8. 변경 파일·권한 경계

- 바깥 영역(계약 5절 S3 행 밖)을 건드린 곳:
  - `eslint.config.js`: `ignores` 를 `out/**` → `**/out/**`(스테이징 JS 를 린트하지 않게), `.prettierignore` 에 `out/`. 루트 설정이라 메인 세션 승인이 필요합니다.
  - `apps/extension/vite.config.ts`: 계약 5절대로 S2(벤치 `input`)와 구역을 나눴습니다. 이 작업은 파일 앞부분(`kind`·플러그인 함수), `plugins`·`define`, `outDir`·`sourcemap` 줄만 바꿨고 `rolldownOptions.input` 은 그대로입니다.
  - `apps/extension/viewer.html`: `정보` 버튼 한 줄만 추가했습니다(벤치 버튼 줄은 그대로).
  - `apps/extension/package.json`: `version` 1.0.0, `package` 스크립트.
- 매니페스트 `name`·`description` 은 이 작업이 임시로 정했습니다. `PDF Editor`, "PDF 문단·표·벡터 패스를 브라우저 안에서 직접 편집하고 저장합니다. 모든 처리는 이 기기 안에서 이루어집니다."(약 60자).

## 9. 남은 일

| # | 내용 | 담당 |
| --- | --- | --- |
| 1 | 매니페스트 이름·설명 문구 승인(상표 검색은 사용자). 개발 빌드 이름 `PDF Editor (dev)` 유지 여부 | 메인 세션·사용자 |
| 2 | 머지 시 `vite.config.ts`·`viewer.html` 충돌 해소(S2 벤치 `input`·벤치 버튼). 해소 뒤 스토어 빌드에서 벤치 진입 파일이 번들에 들어가는지, 벤치 버튼이 `#diag` 안에 있어 숨겨지는지 확인 | 메인 세션 |
| 3 | S1 머지 뒤 `heap.model`·`journalBytes` 값 연결 확인(지원 크기 알림 경계가 S1 모델로 바뀜). 저널 안내는 `journalBytes` 가 오기 전까지 나오지 않음 | 메인 세션 |
| 4 | 릴리스 태그 `v1.0.0` 생성·push(소스 링크 `/tree/v1.0.0` 이 유효해지는 조건). 소스맵 zip 을 릴리스 자산으로 올림 | 사용자 승인 후 메인 세션 |
| 5 | 서드파티 고지 법적 검토(특히 MuPDF thirdparty 목록의 링크 판정, FreeType FTL 선택, OFL 예약 이름 해석) | 사람 확인 |
| 6 | 개발자 대시보드에 zip 초안 업로드 오류 없음 확인, 비공개 설치 뒤 진단의 `interceptionMode` 확인(스토어 빌드는 진단 UI 가 숨겨져 있으므로 `chrome://extensions` 서비스 워커 콘솔의 `interception mode = mime-handler` 로 확인) | 사용자 |
| 7 | Chrome 128–150 레거시 빌드를 따로 배포할 필요가 생기면 `dist`(dev) 매니페스트에서 이름·진단을 정리한 `legacy` 종류 추가 | 후속 |
| 8 | 스토어 빌드의 `?e2e` 시험 이음매(`window.__pe`)는 코드에 남아 있음. 쿼리 `e2e` 를 붙여야만 노출되며 확장 페이지 안에서만 동작. 필요하면 스토어 빌드에서 제거 | 후속 |
| 9 | 전체 e2e 1회 실행 중 `path-integration.spec.ts` 의 `#pe-path-fill` 이 활성화되지 않아 실패한 적이 1회 있음(첫 Alt+클릭 소실, S5 대상 M4 제한과 증상이 같으나 원인은 확인하지 못함). 단독 3회·재실행은 통과 | S5 |

## 10. 뷰어 툴바 수정 (사용자 결정 2026-10-21)

| 항목 | 변경 |
| --- | --- |
| 문맥 배지 삭제 | `#context-badge` 요소·CSS 삭제. 문맥 값은 `document.body.dataset.context = source.kind` 로 남기고 e2e(`extension.spec.ts`·`dnr-legacy.spec.ts`)는 `body[data-context]` 를 읽음 |
| 툴바 고정 | `body` 를 세로 flex(`height: 100%`, `overflow: hidden`)로 두고 `#toolbar`·`#notice-bar` 는 `flex: none`, `#page-container` 가 `flex: 1; overflow: auto` 스크롤 상자. sticky 제거. 창 폭 그대로 맨 위에 있고 문서 영역만 가로·세로 스크롤 |
| 검색창·알림 줄 위치 | `#notice-bar` 의 `top: 40px` 삭제(흐름 배치). 검색창 `--pe-find-top` 은 `main.ts` 의 `ResizeObserver`(툴바·알림 줄)가 실제 하단 + 4px 로 갱신 |
| 가운데 정렬 | `justify-content: safe center`(창보다 넓으면 왼쪽부터 시작해 잘리지 않음) |
| 쪽 화살표 | `.pe-arrow` 의 `top: calc(50vh - 22px)` → `calc(50% - 22px)`(스크롤 상자 높이 기준). `style.css` |
| 사용 가능 폭 | `main.ts` `getEnvironment.availableWidth` 를 `documentElement.clientWidth` 에서 `#page-container.clientWidth` 로 변경(스크롤바 제외, 이전과 같은 값) |
| 유동 배치 | `#toolbar` 는 `flex-wrap`, 컨트롤 묶음(쪽 이동·되돌리기·다시 실행·검색 등)이 앞, 저장 버튼이 그다음. 상태 줄은 말줄임. 600px 이하: 글자·패딩 축소, `다른 이름으로 저장` → `새 이름`, `downloads 저장` 숨김, 상태 줄은 자기 줄. 2026-10-22 변경(10.1): 판정은 100% 환산 폭(`html[data-narrow]`), 저장 버튼 셋은 저장 메뉴 하나(`새 이름` 줄임 글자 삭제), 좁은 폭에서는 메뉴의 `downloads 저장` 숨김 |
| 진단 패널(dev) | `<details id="diag">` 의 `open` 제거(기본 접힘). 열려 있으면 문서 영역을 줄여 `path-integration` e2e 의 클릭 좌표가 패널에 가려졌다. 진단 로그 텍스트는 접혀 있어도 읽힘 |
| 알림·대화상자·검색창 | 대화상자 `max-width: min(460px, 100vw − 24px)`·`max-height: 100dvh − 24px`·스크롤, 검색창 `max-width: 100vw − 24px`·줄바꿈·입력창 `min(220px, 40vw)`, 알림 줄은 줄바꿈 |

- window 스크롤 의존 조사: `scrollTo`·`scrollY`·`scrollTop` 등을 쓰는 코드가 뷰어·viewer-ui 소스에 없습니다. 위치 계산(`EditEntry`·`DebugLayer`·`EditableMarks`·`TextLayer`·`EditorLayer`·`PathLayer`)은 `getBoundingClientRect()`(뷰포트 기준)라 스크롤 상자가 바뀌어도 그대로 맞고, 찾기 결과 스크롤(`HighlightLayer` 의 `scrollIntoView`)은 가장 가까운 스크롤 조상(`#page-container`)을 따라갑니다. `PathLayer.tsx` 는 수정하지 않았고 보고할 문제도 없었습니다. `position: fixed` 요소(검색창, 디버그 HUD, 편집 안내, 표시 범례)는 뷰포트 기준이라 그대로입니다.
- 시험(2026-10-21): `e2e/toolbar-layout.spec.ts` 11건. 뷰포트 400·800·1280 px, 확대는 CDP `Emulation.setDeviceMetricsOverride`(CSS 뷰포트 1/배율, dpr 배율 — Ctrl +/− 와 같은 효과) 1·1.5·2, 문서 영역에 3000 px 요소를 더해 가로·세로로 끝까지 스크롤한 뒤 `#toolbar` 의 `top=0`·`left=0`·`width=창 폭`, 저장·다른 이름·정보 버튼과 툴바 모든 요소가 화면 안, 창 자체는 스크롤되지 않음, 왼쪽이 잘리지 않음을 확인합니다. 400 px 에서 개발 버튼 숨김, 넓은 창에서 쪽 가운데 정렬, 알림 줄·검색창·정보 대화상자가 화면 안(검색창은 알림 줄 아래), `#context-badge` 없음·`body[data-context]` 있음. 2026-10-22 에 실제 탭 배율 시험으로 바꿨습니다(10.1.6).
- 한계(2026-10-21): 실제 Ctrl +/− 와 Ctrl+휠 조작(브라우저 UI)은 자동화하지 못해 CDP 뷰포트·dpr 에뮬레이션으로 대신했습니다. 2026-10-22 부터는 `chrome.tabs.setZoom` 으로 실제 탭 배율(브라우저 확대와 같은 경로)을 겁니다. 브라우저 UI 조작 자체는 여전히 사용자 확인 항목입니다(10.1.7).

### 10.1 툴바 수정 2 (사용자 요청 2026-10-22)

브랜치 `m5-toolbar`(기준 main 3377d4f, worktree `/mnt/nas4/kjune/pdf-editor-m5ui`). 3절 스모크 항목의 "downloads 저장 버튼이 DOM 에 있으나 보이지 않음"과 6절 마지막 줄의 `downloads 저장` 버튼 설명은 이 절이 대체합니다(스토어 빌드에는 그 항목이 없습니다).

#### 10.1.1 브라우저 확대·축소에도 머리 영역 크기 고정

| 항목 | 내용 |
| --- | --- |
| 배율 f | `chrome.tabs.getZoom(tabId)` 와 `chrome.tabs.onZoomChange`(그 탭만). tabId 는 MIME handler 면 `StreamInfo.tabId`, 확장 페이지 탭이면 `chrome.tabs.getCurrent()`. 구현 `apps/extension/src/viewer/header-zoom.ts` |
| 역보정 | 머리 영역(`#toolbar`·`#notice-bar`, 툴바 안의 검색창·저장 메뉴 포함)에 CSS `zoom: var(--pe-header-zoom)` = 1/f. 문서 영역·대화상자·쪽 위 안내(편집 안내·범례·화살표)·진단 패널은 바꾸지 않음 |
| 보조 감지 | `resize`·`matchMedia('(resolution: …dppx)')` 에서 dpr 이 바뀌면 같은 비율의 확대 변화로 보고 그 프레임 안에서 바로 추정한 뒤 탭 배율 조회로 확인(다른 배율 모니터로 옮긴 경우 바로잡음). onZoomChange 가 프레임 배율 변화보다 먼저 오면(MIME handler 최상위 실측: 이벤트 때 dpr 1, 0.3 ms 뒤 resize 에서 1.5) 프레임 dpr 이 바뀔 때 적용. 탭 배율을 못 구하면 dpr 변화만으로 추정(시작 시 100% 가정) |
| 좁은 배치 | `@media (max-width: 600px)` 를 없애고 100% 환산 폭 `innerWidth × f ≤ 600` 이면 `html[data-narrow]`. 확대로는 켜지지 않고 창을 줄이거나 나누면 켜짐. 내용(글자·여백 축소, 상태 줄 자기 줄·말줄임, 개발 전용 메뉴 항목 숨김, 여러 줄 접힘)은 이전과 같음 |
| 검색창 | 툴바 안(zoom 1/f)에 그려지므로 `--pe-find-top` 을 머리 영역 px(화면 px × f)로 계산(`main.ts` `syncFindTop`). zoom 아래에서 `vw` 도 zoom 배가 되어 검색창의 `vw` 길이를 `--pe-header-zoom` 으로 나눔(`packages/viewer-ui/src/style.css`) |
| 문서 영역 | 바꾸지 않음(쪽 맞춤, 최대 1.5배). 1280 px 창 실측 쪽 물리 폭: 50% 447 px, 100% 893 px, 200% 1,056 px. 툴바 물리 크기는 셋 모두 1280×37 px |
| 시작 순서 | 문맥을 정한 직후, PDF 바이트를 받기 전에 보정을 붙임(`resolveViewerSource` 의 `onContext`). 그 전(모듈 실행부터 getZoom 응답까지)은 보정 없음 |
| 진단 | `html[data-zoom]`·`html[data-zoom-mode]`(off·tabs·dpr), 진단 로그 `header-zoom`·`header-zoom-tab`·`header-zoom-change`·`header-zoom-error` |

#### 10.1.2 문맥별 동작

| 문맥 | 보정 | 근거 |
| --- | --- | --- |
| 확장 페이지 탭 최상위(`viewer.html?file=`, 파일 선택) | 함 | 실측(헤드리스 Chromium 156): 탭 배율 2 → 프레임 dpr 2, innerWidth 1/2 |
| MIME handler 최상위 | 함 | 실측: PDF URL 페이지의 하위 프레임이지만 탭 배율을 그대로 받음. getCurrent()도 탭 id 를 주나 StreamInfo.tabId 를 씀 |
| 임베디드(embed·iframe·object), DNR 폴백으로 웹 페이지 안 프레임에 뜬 확장 페이지 | 안 함(바깥 페이지 확대를 따름, 좁은 배치는 이전처럼 CSS 폭) | (1) 임베디드 뷰어는 웹 페이지의 일부이고 바깥 상자(embed 크기)가 페이지 확대로 같이 바뀜. 보정하면 50% 에서 상자는 절반인데 툴바는 그대로라 상자 대부분을 툴바가 차지하고, 200% 에서는 반대가 됨. (2) 헤드리스 실측에서 임베디드 뷰어 프레임에 탭 배율이 반영되는 시점이 프레임마다 달랐음(화면 밖 프레임은 1 s 안에 반영되지 않은 경우가 있었고 resize 도 미뤄짐). 탭 배율로 보정하면 프레임 배율과 어긋나는 구간이 생길 수 있음 |

#### 10.1.3 권한

- `chrome.tabs.getZoom`·`onZoomChange`·`getCurrent` 는 권한 없이 동작합니다(`tabs` 권한은 Tab 의 url·title 등에만 필요). 매니페스트는 바꾸지 않았습니다. 스토어 빌드 `permissions` 는 `["downloads"]` 그대로이며 `verify-dist --release` 와 `release-smoke.spec.ts`(매니페스트 단언, 스토어 빌드에서 `data-zoom-mode = tabs` 와 탭 배율 2 보정)가 확인합니다.

#### 10.1.4 레이아웃·편집 표시 한 버튼, 연결 디버그 버튼 제거

| 항목 | 내용 |
| --- | --- |
| 버튼 | `#pe-overlay-toggle` "레이아웃·편집 표시". `#pe-layout-toggle`(레이아웃)·`#pe-mark-toggle`(편집 가능 표시) 삭제. 한 번 누르면 둘 다 켜지고 다시 누르면 둘 다 꺼짐. 하나라도 켜져 있으면 눌림 상태 |
| 패스 선택 | 편집 가능 표시가 켜지면 클릭으로 패스 선택(기존 `showEditable` 연동) → 합친 버튼에 묶임 |
| 한쪽만 가능 | 레이아웃 비활성(`featureDisabledReason`)이면 편집 가능 표시만, 편집 비활성·편집 RPC 없는 호스트면 레이아웃만 켬. 제목(툴팁)에 "레이아웃을 쓸 수 없어 편집 가능 표시만 켭니다: 사유" 형식으로 적음. 둘 다 불가면 버튼 비활성·두 사유 |
| 컨트롤러 | `setOverlays(on)`·`toggleOverlays()`·`overlayToggleState()`·`overlayToggleTitle()` 추가. `toggleLayout`·`edit.setShowEditable` 유지 |
| 편집 중 | 바깥 클릭처럼 편집을 끝내고 켬(이전 `#pe-mark-toggle` 의 `data-pe-keep` 은 두지 않음) |
| 함께 그릴 때 | 확인 결과 두 표시가 같은 상자에 겹쳐 레이아웃의 역할 색 테두리가 편집 가능 테두리에 가려졌음 → 레이아웃은 얇은 테두리(문단 1.5→0.75 px, 셀 안 문단 0.75→0.5, 표 2→1, 격자 0.75→0.5, 도형 2→1, 채움·번호 그대로), 편집 가능 테두리는 문단은 2.5 px 바깥·표 셀은 2.5 px 안쪽(이웃 셀과 겹치지 않게)에 그림, 패스는 그대로. 범례에 "레이아웃(색 = 역할, 번호 = 읽기 순서)" 추가. 한쪽만 켜면 이전 모양 |
| 연결 디버그 | `#pe-debug-toggle` 삭제. `toggleDebug()`·디버그 오버레이는 유지. e2e 는 하니스 `window.__controller.toggleDebug()`, 확장은 `?e2e` 의 `window.__pe.controller.toggleDebug()` 로 켬. 시험 이음매로 켰다가 미구현으로 꺼지면 "비활성: 연결 디버그" 알림은 그대로 |

#### 10.1.5 저장 메뉴

| 항목 | 내용 |
| --- | --- |
| 버튼 | `#save-menu-button` 프린터 아이콘(인라인 SVG, 외부 요청 없음), `aria-label`·`title` "저장", `aria-haspopup="menu"`·`aria-expanded`. 문서를 그리기 전에는 비활성(이전 저장 버튼과 같은 조건) |
| 메뉴 | `#save-menu`(role=menu): 저장(`#save`, Ctrl+S 표시) / 다른 이름으로 저장(`#save-as`) / downloads 저장(`#save-downloads`, 개발 빌드만). 항목 id 는 이전 버튼 id |
| 키보드 | 버튼: Enter·Space·↓ 는 열고 첫 항목, ↑ 는 열고 마지막 항목. 메뉴: ↑↓(순환)·Home·End 이동, Enter·Space 실행, Esc 는 닫고 버튼으로, Tab 은 닫음 |
| 닫기 | 바깥 누름, 창 초점 잃음, 항목 선택(닫은 뒤 저장) |
| 화면 안 배치 | 열 때·창 크기가 바뀔 때 좌우로 넘치면 가로 위치를 옮기고, 아래로 넘치면 최대 높이·스크롤. 머리 영역 확대 보정을 같이 받음 |
| Ctrl+S | 메뉴 없이 바로 저장(열린 메뉴는 닫음). Ctrl+Shift+S 는 그대로 다른 이름으로 저장 |
| 저장 흐름 | `runSave`·저장 전 판정·확인 창("그래도 저장 시도" 포함)·상태 줄 그대로 |
| 스토어 빌드 | `vite.config.ts` 가 스토어 빌드 viewer.html 에서 `#save-downloads` 를 빼고, `main.ts` 의 처리 분기(`__BUILD_KIND__ !== 'store'`)는 스토어 번들에서 사라짐. `html[data-build='store'] #save-downloads` CSS 삭제. `verify-dist --release` 가 스테이징 html·js·css 에 `save-downloads` 가 없고 viewer.html 에 `#save-menu` 가 있는지 검사 |
| 좁은 폭 | 개발 전용 `downloads 저장` 항목 숨김(이전 좁은 폭의 개발 전용 버튼 숨김과 같음) |
| 벤치·스크립트 | `bench.html`·`bench.ts`·`bench-run.ts`·`e2e/bench-*.ts`·`tools/` 는 저장 버튼·툴바 토글을 쓰지 않음(grep). 벤치 하네스 수정 없음. `bench.html` 은 `viewer.css` 를 쓰므로 미디어 쿼리 삭제로 벤치 툴바에는 좁은 배치가 적용되지 않음(벤치 화면은 진단 페이지) |

#### 10.1.6 시험

| 시험 | 내용 |
| --- | --- |
| `apps/extension/test/header-zoom.test.ts` | 보정 문맥, 100% 환산 폭, 시작·탭 배율·이벤트 먼저/프레임 먼저·모니터 배율 변경 바로잡기·늦은 조회 응답 버리기·배경 탭·창 폭만 변경·탭 배율 실패 시 dpr 추정, tabId 출처 |
| `apps/extension/test/source.test.ts` | `onContext` 가 문맥 판정 직후·바이트 수신 전에 불림 |
| `packages/viewer-ui/test/controller.test.ts`·`path-controller.test.ts`·`edit-marks.test.ts` | 합친 토글(함께 켜고 끄기, 한쪽만 켜진 상태, 레이아웃 미구현·편집 RPC 없음·둘 다 불가, 제목), 함께 그릴 때 테두리 위치 |
| `e2e/toolbar-layout.spec.ts` | 실제 탭 배율(`chrome.tabs.setZoom`, 서비스 워커에서) 0.5·1.5·2: 툴바·알림 줄·검색창과 머리 영역 컨트롤의 물리 상자(getBoundingClientRect × devicePixelRatio)가 100% 와 1 px(검색창 1.5 px) 안에서 같음, 문서는 확대·축소(200% > 100% > 50%), 좁은 배치는 창 폭으로만(1000 px 200% 꺼짐, 400 px 100%·50%·200% 켜짐·같은 배치), MIME handler 최상위 보정, 임베디드 세 문맥 보정 없음, 기존 툴바 고정·스크롤·화면 안 시험(확대는 실제 탭 배율로 교체) |
| `e2e/save-menu.spec.ts` | 비활성·아이콘·이름, 마우스(열기·바깥 클릭 닫기·항목 선택 뒤 닫힘·저장), 키보드(Enter·↑↓ 순환·Home·End·Esc·Tab·Enter 실행), Ctrl+S 바로 저장, 320·400·1280 px 와 버튼을 오른쪽 끝에 둔 경우 화면 안 |
| `e2e/path-ui.spec.ts` | 합친 버튼으로 두 표시 함께 켜고 끄기·패스 클릭 선택 해제, 레이아웃 미구현 시 편집 가능 표시만·제목 사유 |
| `e2e/release-smoke.spec.ts` | 스토어 빌드: `#save-downloads` 없음, 메뉴 두 항목, 저장(FSA 없음 → downloads), 확대 보정(권한 추가 없음) |
| 기존 e2e | 저장 버튼 클릭은 `e2e/toolbar-helpers.ts` `chooseSave()`(메뉴를 연 뒤 항목), 레이아웃·편집 가능 표시는 `#pe-overlay-toggle`, 연결 디버그는 컨트롤러 호출로 수정 |

#### 10.1.7 남은 확인

| # | 내용 | 담당 |
| --- | --- | --- |
| 1 | Windows Chrome 실제 Ctrl +/−·Ctrl+휠·메뉴 확대(50·100·200%)에서 툴바·알림 줄·검색창·저장 메뉴 크기 고정, 문서 확대·축소, 창을 줄이거나 나눌 때 좁은 배치. 디스플레이 배율 125·150% 환경 포함 | 사용자 |
| 2 | 배율이 다른 모니터로 창을 옮길 때 툴바가 탭 배율 조회 응답 전까지 잠깐 다른 크기로 보이는지 | 사용자 |
| 3 | 확대된 상태로 뷰어를 열면 getZoom 응답 전(수 ms) 첫 화면은 보정 전 크기일 수 있음 | 관찰 |
| 4 | 임베디드 문맥 보정 안 함(10.1.2) 결정 확인 | 사용자 |
| 5 | 눌린 버튼에 마우스를 올리면 기존 `.pe-btn:hover` 색이 눌림 색을 덮음(이번 범위 밖) | 후속 |
