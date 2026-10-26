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

### 10.2 머리 영역 언어·개발 표시 숨김·쪽 화살표 (사용자 요청 2026-10-23)

브랜치 `m5-windows`(기준 6637829, worktree `/mnt/nas4/kjune/pdf-editor-m5win`). 이 절의 진단 패널 동작은 10절 "진단 패널(dev)" 행과 6절 마지막 줄을 보완합니다(스토어 빌드 동작은 그대로).

#### 10.2.1 언어 방식

| 항목 | 내용 |
| --- | --- |
| 선택 | (b) 코드 안 문자열 표(ko·en) + 언어 감지. `_locales`·`default_locale` 은 추가하지 않음 |
| 언어 판정 | `chrome.i18n.getUILanguage()`(브라우저 UI 언어, 권한 불필요). 없거나 빈 값이면 `navigator.language`. 주 언어 하위 태그(`-`·`_` 앞, 대소문자 무시)가 `ko` 이면 한국어, 그 밖(태그 없음 포함)은 영어. 예: `ko`·`ko-KR`·`ko_KR` → ko, `en-US`·`ja`·`zh-CN`·`kok` → en. 구현 `packages/viewer-ui/src/strings.ts` `resolveUiLang`, 확장 `apps/extension/src/viewer/strings.ts` `detectLang` |
| viewer-ui | `VIEWER_STRINGS.{ko,en}`(`ViewerStrings`)를 `ViewerControllerOptions.strings` 로 주입. 없으면 한국어. 컴포넌트는 `controller.strings` 를 읽고, `EditController`·`PathController` 는 `EditContext.strings`(선택)로 받음. `findLabel`·`overlayToggleState`·`overlayToggleTitle` 은 표를 마지막 인수(기본 한국어)로 받음. viewer-ui 는 확장 API 를 쓰지 않음(하니스·Node 시험 그대로) |
| 확장 | `APP_STRINGS.{ko,en}`(`AppStrings`, 같은 언어의 viewer-ui 표 포함). `main.ts` 가 시작할 때 언어를 정해 `html[lang]` 을 바꾸고, `viewer.html` 의 고정 문자열은 `data-i18n`(글자)·`data-i18n-title`·`data-i18n-aria-label` 키로 바꿈(`applyDomStrings`). 알림·저장 판정·정보 문구 함수(`notices.ts`·`save-plan.ts`·`about.ts`)는 표를 마지막 인수(기본 한국어)로 받음 |
| core 문구 | 저장 힙 판정 문구(`heap.message`, pdf-ops 한국어)는 한국어 화면에서만 그대로 쓰고, 영어 화면은 같은 수치(예상 피크·한계)로 영어 문구를 만듦 |
| 매니페스트 | 바꾸지 않음. 권한·`default_locale` 추가 없음. 스토어 빌드 `permissions` 는 `["downloads"]`, `verify-dist --release` 통과 |

(b)를 고른 근거:

1. viewer-ui 는 확장 API 없이 시험돼야 하므로 문자열을 객체로 주입받아야 합니다. (a)도 결국 `getMessage` 결과로 같은 객체를 만들어야 해 키 목록이 두 군데(messages.json·객체)에 생깁니다.
2. 문구 대부분이 수치를 넣는 함수(쪽 수·n/N·MiB·파일 이름)입니다. TypeScript 인터페이스로 두 언어의 키·인수를 컴파일 때 맞추고, messages.json 자리표시자(`$1`)·키 이름 제약(`[A-Za-z0-9_@]`)을 피합니다.
3. 순수 함수(알림·저장 판정·정보 대화상자)를 Node 단위 시험에서 `chrome.i18n` 흉내 없이 두 언어로 시험합니다.
4. "ko 계열은 한국어, 그 밖은 영어" 규칙을 코드 한 곳(`resolveUiLang`)에 두고 단위 시험합니다. (a)는 Chrome 의 로케일 대체 규칙과 `default_locale` 에 기대며, `default_locale` 을 `en` 으로 두면 스토어 등록 기본 언어도 바뀝니다(사용자 결정 사항).
5. 매니페스트를 바꾸지 않아 스토어 매니페스트 검사·`name` 검사(`PDF Editor`)에 영향이 없습니다.

스토어 등록 이름·설명 현지화(`_locales` + `__MSG_name__`)는 이 방식과 따로 나중에 더할 수 있습니다(10.2.6).

#### 10.2.2 번역 범위

| 영역 | 내용 | 위치 |
| --- | --- | --- |
| 툴바 | 쪽 이동(이전·다음·쪽 번호 입력 이름·"/ N"), 찾기, 레이아웃·편집 표시(이름·제목·사유 문구), 되돌리기·다시 실행·편집 취소·폴백 표시·태그 PDF 편집 막기(이름·제목), 비활성 알림("비활성: …", 기능 이름), 컨트롤 묶음 이름 | `Controls.tsx` |
| 툴바 편집 알림 | `#pe-edit-notice`: 복구 알림, "…하지 못했습니다: 오류"의 앞부분, redo 소실 안내 | `edit-controller.ts`·`path-controller.ts` |
| 검색창 | 입력란 placeholder·이름, 결과 수("결과 없음"·"검색 중"·사용 불가·실패), 이전·다음 결과, 대소문자 구분, 닫기 | `FindBar.tsx`·`search-nav.ts`·`controller.ts` |
| 쪽 화살표 | 이름·제목 | `PageArrow.tsx` |
| 저장 메뉴 | 버튼 이름·제목, 저장·다른 이름으로 저장·downloads 저장(제목 포함) | `viewer.html` |
| 정보 버튼·PDF 열기 | 글자·제목 | `viewer.html` |
| 상태 줄 | 여는 중·열기 실패·복구 중·Worker 오류·저장 중·저장됨(파일 이름 / 다운로드)·저장 취소·저장 실패·저장 중단·저장 전 판정 실패·편집 미완료·렌더 경과·벤치 측정 | `main.ts` |
| 알림 줄 | Redact 보고, file:// 접근 안내, 지원 크기(열 때·저장 전 판정), 저널 상한, 저장 뒤 되돌리기 안내, 복구 진행·완료, 닫기 버튼 제목 | `notices.ts`·`main.ts` |
| 대화상자 | 저장할 수 없음·저장 전 확인(힙 경고·커진 힙 재시도·태그 구조·PDF/A·편집 쪽 기록·저널 권고, 버튼)·저장 실패 재시도, 정보 대화상자 전체 | `save-plan.ts`·`about.ts`·`main.ts` |

남은 한국어 전용 문자열:

| 영역 | 예 | 위치 |
| --- | --- | --- |
| 쪽 위 편집 UI | 편집기 안내·버튼·경고 목록, 편집 불가 팝오버("이 문단은 편집할 수 없습니다"), 패스 선택 패널(점 편집·삭제·색·두께), 편집 가능 표시 범례·테두리 툴팁, 태그 PDF 안내, 편집 쪽 기록 안내, 편집기 안 복구 안내 | `EditorLayer.tsx`·`EditEntry.tsx`·`PathLayer.tsx`·`EditableMarks.tsx`·`edit-marks.ts`·`edit-session.ts` |
| 편집 제한 사유 | `LIMIT_LABELS` 30종, 태그 편집 막기 사유 | `edit-labels.ts` |
| 오류 상세 | Worker·core·복구 계층·저장 대상이 만드는 오류 문장(상태 줄·알림의 콜론 뒤에 붙음), core 저장 경고(`SavePlan.warnings`), "미구현" 표지 | `recovery.ts`·`save-target.ts`·`source.ts`·core·pdf-ops |
| 개발 표시 | 진단 패널("M0 진단"·"진단 결과 복사"·"전체 저장 측정"·"M5 벤치마크 페이지"), 연결 디버그 오버레이·HUD, 벤치 페이지 | `viewer.html`·`DebugLayer.tsx`·`debug-info.ts`·`bench.html` |
| 매니페스트 | `description`, `action.default_title`("PDF Editor 뷰어 열기") | `manifest.json` |

#### 10.2.3 개발 표시 숨김

진단 패널을 다시 보는 방법(개발 빌드만): 주소에 `?diag` 를 붙여 엽니다(`viewer.html?diag`, `viewer.html?file=<URL>&diag`). MIME handler 로 연 PDF 처럼 주소를 바꿀 수 없으면 뷰어를 누른 뒤 **Ctrl+Alt+Shift+D** 를 누릅니다(다시 누르면 숨김, 물리 키 기준이라 한글 입력 상태와 무관). 켜면 `html[data-diag]` 이 붙고 진단 기록 `diag-visible` 이 남습니다. 스토어 빌드에는 이 코드가 없고 진단 패널은 늘 숨깁니다(D6).

| 항목 | 처리 | 근거 |
| --- | --- | --- |
| 진단 패널 `#diag`("M0 진단": 진단 로그·진단 결과 복사·전체 저장 측정·M5 벤치마크 페이지 링크) | 숨김(`?diag`·단축키로 보임). DOM·`#diag-log` 내용은 유지, `diag.add` 수집 그대로 | 개발·진단용. e2e 는 숨겨진 `#diag-log` 의 textContent 를 읽음 |
| 저장 메뉴 downloads 저장(`#save-downloads`, 개발 빌드만) | 숨김(같은 방법으로 보임). 숨기면 메뉴 키보드 이동은 두 항목만 돎 | M0 진단 경로 강제 |
| 상태 줄 렌더 경과("N 페이지 · 1페이지 렌더 완료")·대기("대기")·전체 저장 측정 결과 | 숨김(`#status[data-dev]`). 넓은 배치에서는 자리만 남아 정보 버튼이 오른쪽 끝에 있고, 좁은 배치에서는 줄을 차지하지 않음. `data-state` 는 그대로 | 렌더 경과는 개발 표시, 쪽 수는 툴바 "/ N" 에 있음 |
| 저장됨 상태의 채널 이름 | "저장됨: chrome.downloads" → "저장됨: 다운로드"(영어 "Saved: Downloads"). 실패·취소는 "cancelled: …" 대신 "저장을 취소했습니다"·"저장 실패: 오류" | 내부 API 이름 노출 제거 |
| 여는 중·저장 중·저장됨·저장 실패·저장 중단·복구 진행·Worker 오류·열기 실패, "PDF 파일을 선택하세요" | 남김 | 사용자에게 필요한 상태 |
| 알림 줄 전체(크기 안내·복구·Redact·file:// 접근·저널·저장 뒤 안내) | 남김 | 같음 |
| 툴바 "비활성: 기능" 알림(`#pe-notice`) | 남김 | 기능을 쓸 수 없는 이유. "연결 디버그" 는 시험 이음매로 켤 때만 나옴 |
| 연결 디버그 오버레이·HUD | 이미 툴바 버튼 없음(10.1.4). 변경 없음 | 시험 이음매(`toggleDebug()`)로만 켬 |
| `html[data-zoom]`·`data-zoom-mode`·`body[data-context]`·`#status[data-state]` | 그대로(화면에 보이지 않는 속성) | 시험·진단용 |

#### 10.2.4 쪽 화살표

| 항목 | 이전 | 이후 |
| --- | --- | --- |
| 버튼 크기 | 32×44 px | 48×96 px(가로 1.5배, 세로 약 2.2배, 터치 영역 48×96) |
| 아이콘 | 글자 `‹`·`›` 22 px | 인라인 SVG 셰브런 30 px, 선 굵기 2.75 |
| 기본 판 | `#4a4f54` 불투명(문서 배경 `#525659` 와 대비 약 1.1:1), 글자 `#eee`(대비 약 7:1) | `rgb(32 33 36 / 88%)`(배경 위 합성 대비 약 2.0:1), 흰 아이콘(대비 약 15:1), 테두리 흰색 30%, 그림자 |
| hover | 배경 `#5a6066` | 판 `rgb(72 76 80 / 96%)`, 테두리 흰색 60%. 누름(active) `#5f6368` |
| focus-visible | 2 px `#8ab4f8`, 간격 1 px | 3 px `#8ab4f8`, 간격 2 px |
| 비활성(첫·마지막 쪽) | 전체 불투명도 0.35 | 판 40%, 아이콘 흰색 30%, 테두리 10%, 그림자 없음 |
| 칸·쪽 맞춤 | 칸 32 + 간격 4·4, `PAGE_ARROW_GUTTER` 40 | 칸 48 + 간격 3·3 = 54, `PAGE_ARROW_GUTTER` 56(쪽 비트맵 폭 올림 1 px 여유 2 px 포함) |
| 좁은 창 | 쪽 최소 폭(320 px) 때문에 가로로 넘치면 화살표가 쪽과 함께 스크롤되어 화면 밖으로 나감 | 칸이 `position: sticky`(왼쪽 `left: 0`, 오른쪽 `right: 0`)라 넘칠 때만 문서 영역 안쪽 여백(16 px) 가장자리에 붙어 쪽 가장자리 위에 겹침. 넘치지 않으면 쪽 바깥 여백에 있음 |

- 1280 px 창 실측(영어, 612 pt 쪽): 쪽 918 px(최대 배율 1.5 라 이전과 같음), 화살표는 쪽 왼쪽·오른쪽 3 px 바깥, 가로 넘침 없음. 400 px 창: 쪽 320 px(최소 폭)로 문서 영역이 60 px 넘치고, 다음 화살표가 오른쪽 가장자리에서 쪽 위에 겹침.
- 쪽 위에 겹치는 범위: 넘치지 않는 창(약 464 px 이상)에서는 0. 좁은 창에서는 버튼 48×96 만 겹치고 칸의 나머지는 포인터를 받지 않음.
- 클릭·키보드(단축키 없음, Tab 초점)·편집 중 이동 시 커밋 동작은 그대로.

#### 10.2.5 시험

| 시험 | 내용 |
| --- | --- |
| `packages/viewer-ui/test/strings.test.ts` | 언어 판정(ko·ko-KR·KO_kr → ko, en-US·ja·zh-CN·kok·없음 → en, 비어 있지 않은 첫 태그), 두 표의 키(중첩 포함) 일치, 영어 표에 한글·빈 문자열 없음, `findLabel` 표 적용 |
| `packages/viewer-ui/test/controller.test.ts`·`edit-controller.test.ts` | 기본 표 한국어·옵션 표 영어, 검색 미구현 문구 영어, 레이아웃·편집 표시 제목 영어, 복구 알림 영어 |
| `apps/extension/test/strings.test.ts` | `detectLang`(UI 언어 우선·navigator 대체), 두 표 키 일치·영어 한글 없음, 알림 줄·저장 전 판정(core 한국어 문구 대신 수치 문구)·정보 대화상자 영어, `?diag`·Ctrl+Alt+Shift+D 판정 |
| `e2e/i18n.spec.ts` | en-US: 툴바·검색창·저장 메뉴·쪽 화살표 영어, 머리 영역 글자·title·aria-label·placeholder 에 한글 없음, 알림 줄(크기·Redact)·저장 확인 대화상자·상태 줄("Save cancelled"·"Saved: Downloads")·정보 대화상자 영어. ja-JP → 영어, ko-KR → 한국어 |
| `e2e/diag-display.spec.ts` | 기본 숨김(진단 패널·버튼·링크·downloads 저장·렌더 경과), 진단 기록 수집 유지, 문서 영역이 창 아래까지, `?diag` 로 보임, Ctrl+Alt+Shift+D 켜고 끄기 |
| `e2e/save-menu.spec.ts` | 진단 표시 꺼짐: 두 항목·↑↓ 두 항목 순환. 세 항목 시험은 `?diag` 로 |
| `e2e/page-nav.spec.ts` | 화살표 48×96 이상·SVG, 기본·hover·비활성 모양 구분, 기본 판 88%. 400 px 창에서 쪽이 넘치면 두 화살표가 보이는 가장자리 안에 있고 끝까지 스크롤해도 이전 화살표가 남음, 이동 동작 |
| `e2e/toolbar-layout.spec.ts` | Playwright 프로젝트 `en` 으로 영어 툴바에서 한 번 더 실행(좁은 배치·실제 탭 배율 0.5·1.5·2 보정·화면 안). 좁은 배치 상태 줄 폭은 진단 표시를 켜고 잼 |
| 기존 e2e | 로케일을 `ko-KR` 로 고정(`e2e/locale.ts`, `playwright.config.ts` 프로젝트 `ko`). Linux Chromium 은 `--lang` 을 무시하고 Playwright `locale` 은 `getUILanguage()` 에도 반영됨(실측). downloads 저장을 누르는 시험은 `chooseSave()` 가 단축키 처리로 진단 표시를 켠 뒤 누름 |

#### 10.2.6 남은 확인

| # | 내용 | 담당 |
| --- | --- | --- |
| 1 | 영어 문구 검토(특히 "Show fallback", "Block tagged PDF edits", 알림·대화상자 문장) | 사용자 |
| 2 | 스토어 등록 이름·설명 현지화(`_locales/{ko,en}` + `default_locale`) 여부와 기본 언어. 넣으면 `verify-dist --release` 의 `name` 검사를 `__MSG_…__` 에 맞게 바꿔야 함 | 사용자 |
| 3 | 쪽 위 편집 UI·편집 제한 사유 영어화(10.2.2 남은 표) | 후속 |
| 4 | Windows Chrome 영어 UI(설정 → 언어 → Chrome 표시 언어)에서 헤더 영어, 한국어 UI 에서 한국어 확인 | 사용자 |
| 5 | 좁은 창에서 쪽 위에 겹치는 화살표가 텍스트 선택·편집에 방해되는지 | 사용자 |

### 10.3 스토어 이름·설명, 쪽 위 편집 UI 언어, 좁은 창 쪽 화살표 (사용자 결정 2026-10-26)

브랜치 `m5-windows`(기준 cdbc553, worktree `/mnt/nas4/kjune/pdf-editor-m5win`). 10.2.1 의 "`_locales`·`default_locale` 은 추가하지 않음"·"매니페스트 바꾸지 않음"과 10.2.2 의 남은 한국어 전용 표 중 쪽 위 편집 UI·편집 제한 사유·오류 상세·매니페스트 행, 10.2.4 의 좁은 창 행은 이 절이 대체합니다. 화면 문구 방식(코드 안 문자열 표 + `resolveUiLang`)은 그대로입니다.

#### 10.3.1 스토어 등록 이름·설명 현지화

| 항목 | 내용 |
| --- | --- |
| 매니페스트 | `default_locale: "en"`, `name: "__MSG_appName__"`, `description: "__MSG_appDescription__"`, `action.default_title: "__MSG_actionTitle__"`. 권한은 그대로(스토어 `permissions` = `["downloads"]`, D7) |
| 메시지 | `apps/extension/_locales/{en,ko}/messages.json`. `appName` 두 언어 모두 "PDF Editor". `appDescription` 은 `docs/store/listing.md` 요약(132자 이하)과 같음: en 100자, ko 61자. `actionTitle` en "Open PDF Editor viewer", ko "PDF Editor 뷰어 열기" |
| 개발 빌드 | 매니페스트는 같고, vite 플러그인이 내보내는 messages.json 의 `appName` 에 " (dev)" 를 붙임(`scripts/manifest.mjs` `buildLocaleMessages`). 이름이 메시지 참조가 아니면 이전처럼 매니페스트 이름에 붙임 |
| 언어 선택 | Chrome 이 정함(UI 언어 → 없으면 `default_locale` en). ja 등 그 밖의 언어는 en. 화면 문구 규칙(ko 계열이면 한국어, 그 밖은 영어)과 결과가 같음 |
| `verify-dist` | 개발·스토어 공통: `default_locale` en, 세 필드가 `__MSG_…__`, `_locales` 언어가 정확히 en·ko, 언어별 값 있음, 이름(스토어 "PDF Editor", 개발 "PDF Editor (dev)"), 설명 132자 이하. `--release`: zip 항목에 `_locales/en/messages.json`·`_locales/ko/messages.json` 포함(기존 zip = 스테이징 일치 검사와 별도) |
| 등록 자료 | `docs/store/listing.md`: 현지화 반영 사실, 기본 언어 영어, 대시보드는 언어별로 상세 설명·스크린샷을 따로 입력한다는 주의 |

- 실측(Playwright 번들 Chromium, Linux): 확장 메시지 언어는 환경 변수 `LANGUAGE` 를 따르고 Playwright `locale` 은 반영되지 않습니다(화면 문구의 `getUILanguage()` 는 `locale` 을 따름). `chrome.runtime.getManifest()` 는 메시지를 푼 값을 줍니다. `LANGUAGE=ko` → 이름 "PDF Editor (dev)"·한국어 설명, `en_US`·`ja` → 영어 설명.

#### 10.3.2 쪽 위 편집 UI·편집 제한 사유·오류 상세

| 영역 | 처리 | 위치 |
| --- | --- | --- |
| 편집 불가 팝오버 | 제목(문단·셀)·닫기·사유 목록·태그 편집 막기 사유 | `EditEntry.tsx`·`edit-controller.ts` |
| 편집기 | 글리프 없음 표시 제목, 영역 초과 문구·되돌리기(제목), 반영 중 안내, 미리보기 갱신 실패, 경고 목록 이름·경고 문장, 태그 안내, 편집 쪽 기록 안내, 입력란 이름, 편집기 안 복구 안내 | `EditorLayer.tsx`·`edit-session.ts` |
| 패스 패널 | "패스 N개 선택"·채움 색·선 색·선 두께·점 편집(제목 둘)·삭제(제목)·선택 해제·제한 사유·동작 오류 | `PathLayer.tsx`·`path-controller.ts` |
| 편집 가능 표시 | 범례 다섯 줄, 툴팁(종류·편집 가능·제한: 사유) | `EditableMarks.tsx`·`edit-marks.ts` |
| 편집 제한 사유 | `LIMIT_LABELS`(ko)·`LIMIT_LABELS_EN` 30종(문단 9·연산 14·패스 8, `singular-ctm` 공통). 표에 없는 코드는 "Cannot be edited (코드)" | `labels-data.ts`·`edit-labels.ts` |
| 편집 경고 | `WARNING_TEXTS_KO`·`EN`: 종류 18 + tagged-structure-unlinked 의 경우 2(form-clone·path-removed) | 같음 |
| 오류 상세 | 툴바 편집 알림·검색 실패·레이아웃·편집 표시 사유·쪽 렌더 실패·편집기 오류 줄·상태 줄(열기·저장 전 판정·저장 실패) | `error-text.ts`, 확장 `AppStrings.errorText` |
| core 저장 경고 | `SavePlan.warningCodes`(edit-engine-failed) → 영어 문장 두 줄 | 확장 `save-plan.ts` |
| 저장 실패 원인 | `SaveOutcome.errorCode`(write-permission-denied·no-downloads) → 문구(한국어도 이 문구로 바뀜) | 확장 `save-target.ts`·`main.ts` |

core·Worker 문장의 처리:

| 문장 | 처리 | 근거 |
| --- | --- | --- |
| 제한 사유 설명(`ParagraphLimit.detail`·`PathLimit.detail`) | 코드(`reason`·`code`)가 이미 함께 옴. 한국어 화면은 설명 그대로(이전 동작, 글꼴 리소스 이름·연산자 같은 진단 정보 포함), 영어 화면은 사유 코드 문구 | 설명은 진단용 변수 값을 담은 문장이라 같은 수준의 영어 문장을 만들려면 pdf-ops 20여 곳에 값 필드를 더해야 함. 사유 코드 문구로 사용자에게 필요한 뜻은 전달됨 |
| 편집 경고(`EditWarning.message`) | `count`·`chars`·`variant` 필드를 더해(pdf-ops `font-assign.ts`·`edit-plan.ts`·`path-edit.ts`) 영어 문장을 표로 만듦. 한국어는 message 그대로 | 수치·글자를 코드로 넘김 |
| 저장 경고(`SavePlan.warnings`) | `warningCodes` 추가. 실패 사유 문장(`#failure`)은 영어 문장에 넣지 않음 | 실패 사유는 내부 오류 문장 |
| Worker·core 예외(core 약 85곳의 `throw new Error('…')`) | 영어 화면은 오류 이름(`StaleRevisionError`·`PathTargetChangedError`·`WorkerRecoveredError`·`RecoveryFailedError`) → 알려진 한국어 메시지 형태 18종(초안 손상·엔진 정지·편집 불가 문단/패스·저장 중 초안·HTTP 상태 등, 수치는 살림) → 한글 없는 메시지(MuPDF·브라우저)는 그대로 → 그 밖은 "An internal error occurred." 원 메시지는 진단 기록에 남음 | 예외를 모두 코드로 바꾸면 core·pdf-ops 전반과 RPC 계약을 고쳐야 함. 사용자가 볼 수 있는 상태 오류만 형태 표로 옮기고 나머지는 내부 오류로 봄 |
| 확장 복구 계층·저장 대상·문서 요청 | `RecoveryFailedError`(이름), `PdfRequestError(status)`, `SaveOutcome.errorCode` 로 코드화. 한국어 메시지는 진단용으로 유지 | 확장 코드라 직접 코드화 |

남은 한국어 전용 문자열(개발 표시 제외):

| 문자열 | 위치 | 화면에 보이는 경우 |
| --- | --- | --- |
| core·pdf-ops 예외 메시지(형태 표에 없는 것) | core `edit-engine.ts` 등 | 영어 화면은 일반 문장으로 바뀜. 한국어 화면에서만 원문 |
| 제한 사유 설명·경고 문장 원문(detail·message) | pdf-ops·core | 한국어 화면에서만 |
| `WorkerRecoveredError` 메시지(복구 계층) | `recovery.ts` | 화면에 직접 나오지 않음(복구 알림은 표 문구) |
| 편집기 내부 오류 `'편집 시작 runs 가 비어 있습니다'` | `edit-model.ts` | 영어 화면은 일반 문장 |
| 기능 비활성 로그의 `feature` 값('문단 편집' 등) | `controller.ts`·`edit-controller.ts`·`path-controller.ts` | 진단 기록만 |
| `failure.ts` 의 '미구현' 판별 | `failure.ts` | 판별용 비교 문자열(표시 아님) |

#### 10.3.3 좁은 창 쪽 화살표 (사용자 결정 2026-10-26 변경)

| 항목 | 내용 |
| --- | --- |
| 결정 | 사용자 결정 2026-10-26(변경): "너무 좁아져서 겹칠 수밖에 없으면 그냥 겹쳐줘." 같은 날 앞 결정(좁은 창은 화살표를 쪽 아래 줄로 옮겨 어떤 폭에서도 겹치지 않게, 커밋 66b2264)을 바꿈. 자리가 있으면 쪽 좌우 바깥 칸(겹치지 않음), 없으면 쪽 가장자리 위에 겹침 |
| 판정 | `page-nav.ts` `pageArrowLayout(문서 영역 clientWidth)`: 좌우 칸 두 몫(56×2)과 여백 32 를 빼고 쪽 최소 폭 320 이 남으면(폭 ≥ 464) side, 아니면 overlay. 경계는 앞 결정과 같음 |
| side | 이전과 같음(쪽 좌우 바깥 칸, 쪽 맞춤 폭에서 칸 몫을 뺌) |
| overlay | 쪽 맞춤 폭에서 칸 몫을 빼지 않음(쪽이 그만큼 넓어짐). 칸은 폭 0·여백 0 이라 레이아웃 폭을 차지하지 않고, 버튼만 쪽 안쪽으로 넘쳐 쪽 가장자리 위에 겹침(`style.css` `[data-pe-arrows='overlay']`, 다음 버튼은 왼쪽 여백 −48 px). 칸이 sticky(`left: 0`·`right: 0`)라 쪽이 최소 폭 때문에 가로로 넘쳐도 문서 영역 보이는 범위 좌우 끝(안쪽 여백 16 px 안)에 붙음. 세로는 아래 '세로' 행. 쪽 아래 줄(`below`) 배치는 제거 |
| 포인터 | 칸은 포인터를 받지 않고 버튼(48×96)만 받음. 버튼 밖 쪽 영역의 텍스트 선택·편집 클릭은 쪽으로 감. 버튼이 덮은 48×96 부분의 쪽 내용은 가려짐 |
| 일치 | 마운트가 `ResizeObserver` 로 문서 영역에 `data-pe-arrows` 를 붙이고, 확장 `getEnvironment` 가 같은 함수로 `availableWidth` 를 정함. 렌더 배율(cssScale × dpr)·머리 영역 확대 보정은 바뀌지 않음(문서 영역 폭만 입력) |
| 이동 | 툴바 ‹ › 그대로. overlay 에서도 화살표가 보이는 범위 좌우 끝에 있어 스크롤 없이 누름 |
| 세로 | side·overlay 공통. 칸(`.pe-arrow-slot`)을 세로 sticky(`top: 0`)로 두고, 버튼은 칸 안에서 sticky(`top: calc(50% - 48px)`)로 문서 영역 보이는 범위 세로 가운데를 잡음. 쪽이 문서 영역보다 길어도 스크롤 위치와 관계없이 가운데에 남음(사용자 승인 2026-10-27, 아래 '세로 위치') |

실측(헤드리스 Chromium, 612×792 pt 쪽, 창 높이 480 px, 스크롤바 없음, 2026-10-26). 화살표 위치는 문서 영역 왼쪽 끝 기준 x 범위:

| 창 폭 | 문서 영역 | 배치 | 쪽 캔버스 폭 | 화살표 | 가로 넘침 |
| --- | --- | --- | --- | --- | --- |
| 320 px | 320 | overlay | 320(최소 폭) | 이전 16–64, 다음 256–304. 보이는 범위 좌우 끝에서 16 px 안, 쪽 위. 가로·세로 끝까지 스크롤해도 같음 | 32 px(쪽 최소 폭 몫, 화살표로 늘지 않음) |
| 400 px | 400 | overlay | 368 | 이전 16–64, 다음 336–384. 쪽 좌우 가장자리 위 | 없음 |
| 464 px | 464 | side | 320 | 쪽 좌우 3 px 바깥 | 없음 |
| 800 px | 800 | side | 656 | 쪽 좌우 3 px 바깥 | 없음 |
| 1280 px | 1280 | side | 918(최대 배율 1.5) | 쪽 좌우 3 px 바깥 | 없음 |

- 1280 px 행은 앞 실측입니다(side 는 바뀌지 않음).
- 스크롤바가 있는 환경(Windows 기본 약 15–17 px)에서는 문서 영역이 그만큼 좁아 창 폭 약 480 px 미만부터 overlay 가 됩니다.
- 세로: 아래 '세로 위치'에서 해결했습니다(이전 알려진 문제).

세로 위치(해결, 사용자 승인 2026-10-27)

| 항목 | 내용 |
| --- | --- |
| 문제 | 칸 높이가 쪽 높이가 아니라 문서 영역 안쪽 높이(높이가 정해진 한 줄 flex 의 줄 높이)였음. 버튼의 세로 sticky 는 칸 안에서만 움직이므로, 쪽이 문서 영역보다 길면 스크롤할수록 버튼이 칸과 함께 위로 밀려 나감(800×480 창 끝까지 스크롤: 버튼 위 −70·아래 26, 보이는 범위 위 37, 612×792 pt 쪽) |
| 방식 | 칸에 `top: 0` 을 더해 칸 자체를 세로 sticky 로 둠(이미 가로 sticky `left`·`right: 0`). 칸은 문서 영역(스크롤 상자)의 직계 자식이라 sticky 이동 범위가 스크롤 내용 전체이고, 스크롤하면 보이는 범위 위 끝에 붙어 남음. 칸 높이(보이는 높이 − 여백 32) 안에서 버튼 sticky 가 보이는 범위 가운데(`50% - 48px`)를 잡음 |
| 근거 | sticky 는 흐름 배치를 바꾸지 않아 쪽 위치·쪽 맞춤 폭·스크롤 범위·편집 오버레이 좌표가 그대로임(e2e: 세로 스크롤 높이 = 쪽 높이 + 여백 32). 변경이 `style.css` 한 줄이고 호스트 CSS(`#page-container`)·DOM 은 그대로라 임베디드·bench 도 같음. 대안(칸을 쪽 높이로 늘리기)은 줄 높이를 쪽 높이로 만들려면 `#page-container` 를 여러 줄 flex(`flex-wrap`)로 바꿔야 하는데, 쪽이 최소 폭 때문에 가로로 넘치는 overlay 폭에서 칸이 다음 줄로 내려갈 수 있고 호스트 CSS 를 바꿔야 해 택하지 않음 |
| 유지 | side 겹침 없음, overlay 쪽 위 겹침·칸 폭 0, 가로 넘침 때 보이는 범위 좌우 끝, 칸은 포인터를 받지 않고 버튼만 받음, 쪽이 문서 영역보다 짧으면 이전과 같음(sticky 가 움직이지 않음) |

실측(헤드리스 Chromium, 612×1584 pt 쪽, 2026-10-27). 화살표 y 는 뷰포트 기준, 가운데 차 = 버튼 가운데 − 보이는 범위 가운데. 두 화살표 값이 같아 하나로 적습니다.

| 창 | 문서 영역 | 배치 | 보이는 범위 y | 고치기 전 버튼 y(맨 위 / 가운데 / 끝) | 고친 뒤 버튼 y(세 위치 모두) | 고친 뒤 가운데 차 |
| --- | --- | --- | --- | --- | --- | --- |
| 800×480 | 800×443 | side | 37–480 | 210.5 / −276 / −919 | 210.5–306.5 | 0 |
| 1280×600 | 1280×563 | side | 37–600 | 270.5 / −435 / −1357 | 270.5–366.5 | 0 |
| 400×480 | 400×388 | overlay | 92–480 | 238 / 69 / −229 | 238–334 | 0 |
| 320×480 | 320×363 | overlay | 117–480 | 250.5 / 119 / −130 | 250.5–346.5 | 0 |

#### 10.3.4 시험

| 시험 | 내용 |
| --- | --- |
| `apps/extension/test/release.test.ts` | 기본 언어·메시지 참조, 두 언어 키 일치·값·설명 132자, 설명 = listing.md 요약, 스토어 이름 PDF Editor·개발 (dev) |
| `e2e/release-smoke.spec.ts` | 스토어 스테이징: 이름 PDF Editor, 설명·툴바 제목이 두 언어 메시지 중 하나, `default_locale` en |
| `e2e/i18n.spec.ts` | `LANGUAGE` ko·en_US·ja: 매니페스트 이름(dev)·설명·툴바 제목. en-US 실제 core 판정: 범례·툴팁(vertical-or-rotated)·편집 불가 팝오버·패스 패널·패스 제한 사유(clip-path)·편집기 안내가 영어, 한글 없음 |
| `packages/viewer-ui/test/edit-labels.test.ts` | 사유 30종 두 표 키 = shared-types 사유 목록, 영어 한글 없음, limitItems(ko 설명·en 코드), 경고 문장·경우, 툴팁, 오류 상세 |
| `packages/viewer-ui/test/strings.test.ts` | 새 키 포함 두 표 키 일치(중첩), 영어 한글 없음 |
| `edit-controller.test.ts`·`path-controller.test.ts`·`controller.test.ts` | 영어 팝오버·패스 사유·검색 미구현 문구 |
| `page-nav.test.ts` | `pageArrowLayout` 경계(464·463), side 일 때 칸 자리, overlay 일 때 `availableWidth` = 폭(463·400·320), overlay 400 px 쪽 368 px |
| `e2e/page-nav.spec.ts` | 창 320·400·464·800 px(높이 480, 세로 넘침 전제 확인), 배치 판정. side: 화살표 상자와 쪽 캔버스 상자 겹침 없음·가로 넘침 없음. overlay: 두 화살표가 보이는 범위 안 좌우 끝(16 px 안)에서 쪽 위, 쪽 폭, 가로 넘침은 쪽 최소 폭 몫 이하. 모두 가로·세로 끝까지 스크롤 뒤에도 확인. overlay: 쪽 가운데·화살표 바로 옆·위 지점은 쪽이 받음, 쪽 가운데 클릭이 쪽으로 가고 쪽 이동 없음, 화살표 이동 |
| `e2e/page-nav.spec.ts`(긴 쪽) | 612×1584 pt 쪽, 창 800×480·1280×600·400×480·320×480. 세로 넘침 ≥ 보이는 높이 전제, 세로 스크롤 높이 = 쪽 높이 + 여백 32(화살표가 스크롤 범위를 늘리지 않음). 맨 위·가운데·끝(가로도 같은 비율) 세 위치에서 두 화살표가 보이는 범위 안·세로 가운데 ±8 px, 배치 판정(side 겹침 없음·overlay 위치), 버튼 바로 위·아래 점은 칸이 받지 않음(overlay 는 쪽이 받음). 고치기 전 코드에서 800×480 가운데 위치에서 실패 확인 |
| 확장 단위 | 저장 경고 코드(ko core 문장·en 코드 문장·코드 없음), 상태 줄 오류 상세, 저장 실패 원인 코드, `PdfRequestError`·`RecoveryFailedError` |
| pdf-ops·core | 경고 `count`·`chars`(message 와 일치), `warningCodes` |

#### 10.3.5 남은 확인

| # | 내용 | 담당 |
| --- | --- | --- |
| 1 | 영어 문구 검토(편집 제한 사유 30종, 편집 경고, 패스 패널·범례) | 사용자 |
| 2 | 한국어 화면의 제한 사유를 core 설명(진단 정보 포함) 대신 사유 코드 문구로 바꿀지(지금은 이전 동작 유지) | 사용자 |
| 3 | 저장 실패 원인 두 가지(쓰기 권한 거부·downloads 없음)의 한국어 문구가 "쓰기 권한 denied" 등에서 문장으로 바뀜 | 사용자 확인 |
| 4 | Web Store 대시보드에서 언어별 등록 정보 입력, `chrome://extensions` 에서 한국어·영어 Chrome 의 이름·설명 표시 | 사용자 |
| 5 | Windows Chrome 좁은 창(창 나누기)에서 화살표가 쪽 가장자리 위에 겹쳐 보이고, 버튼 밖 텍스트 선택·편집이 되는지. 긴 쪽을 끝까지 스크롤해도 화살표가 세로 가운데에 남는지 | 사용자 |
