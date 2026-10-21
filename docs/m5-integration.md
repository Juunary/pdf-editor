# M5 통합 결과

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-21 |
| 범위 | `docs/m5-contract.md` 작업 S1–S5 머지 뒤 통합: C7 연결(`docs/m5-heap.md` 8절), 병합 정합 점검(벤치·릴리스 빌드, 스크롤 상자, 캐시 무효화), 전체 검증, 패키지 |
| 기준 | `m5` 브랜치 f43523b(다섯 작업 브랜치 머지) 이후 커밋 |
| 측정 환경 | 서버 `sailab01`, Node 22.18, npm `mupdf` 1.28.1, Playwright 1.64.1 번들 Chromium 156(headless). Windows Chrome 은 미측정 |

## 1. 머지

| 순서 | 브랜치 | 머지 커밋 | 작업 문서 |
| --- | --- | --- | --- |
| 1 | `m5-heap`(S1) | 35ea746 | `docs/m5-heap.md` |
| 2 | `m5-cleanup`(S5) | dd8560c | `docs/m4-integration.md` 9절 |
| 3 | `m5-perf`(S2) | 85617dc | `docs/m5-perf.md` |
| 4 | `m5-release`(S3) | eca71ca | `docs/m5-release.md` |
| 5 | `m5-docs`(S4) | f43523b | `docs/user/`, `docs/store/`, README 등 |

- 충돌 1곳: S2 머지에서 `packages/core/src/session.ts` 첫 줄 `import './wasm-module.js'` 의 주석. 두 작업 모두 같은 import 를 첫 줄에 두었고 S1 주석으로 해소했다(`docs/m5-perf.md` 7절 #5 조건 충족).
- 자동 병합 뒤 정리: 같은 파일에서 S2 가 넣은 `withoutPathSegments` 가 `touch` 의 문서 주석과 그 함수 사이에 끼어 주석 두 개가 이어져 있었다. 위치만 바로잡았다(c3b7831).
- S3 머지(`vite.config.ts`·`viewer.html`)는 충돌 없이 병합되었으나 스토어 빌드에 벤치 페이지가 들어갔다(3.1).

## 2. C7 연결(사용자 승인)

| 항목 | 처리 |
| --- | --- |
| shared-types | `JournalAdvice { advised; journalBytes; incrementBytes; thresholdBytes }`(`save.ts`), `PdfWorkerApi.journalAdvice(): Promise<JournalAdvice>`(`rpc.ts`). pdf-ops `JournalAdvice` 는 이 타입을 다시 내보낸다 |
| Worker | `createPdfWorkerApi`·지연 적재 Worker(`core/src/worker.ts`)가 `PdfSession.journalAdvice()` 로 응답. 문서가 없으면 예외 |
| core export | `index.ts`: `SUPPORTED_INPUT_BYTES`·`supportedInputBytes`·`HEAP_WARN_FRACTION`·`WASM_HEAP_LIMIT_BYTES`·`JournalAdvice`. 뷰어(메인 스레드)는 MuPDF 를 끌어오지 않도록 `client.ts` 가 pdf-ops 하위 경로 `@pdf-editor/pdf-ops/save-method`(새 `exports` 항목)에서 `SUPPORTED_INPUT_BYTES`·`HEAP_WARN_FRACTION`·`WASM_HEAP_LIMIT_BYTES` 를 다시 내보낸다. `verify-dist` 의 "MuPDF 코드는 Worker 청크에만" 검사 통과 |
| 복구 계층 | `ResilientPdf.journalAdvice`, 읽기 RPC 로 분류(복구 뒤 1회 재시도) |
| 커밋 뒤 안내 | `main.ts` 가 `commitParagraphEdit`·`commitPathEdit` 결과를 그대로 돌려준 뒤 `journalAdvice` 를 묻는다. 판정은 core D4 그대로(저널 추정 + 예상 전체 저장 증가분 > 경고선 1,536 MiB). `advised` 이면 알림 줄 `journal` 에 "저장 후 다시 열기" 권고와 편집 기록 크기·경고선을 보인다. 묻지 못하면 진단 로그만 |
| 저장 전 판정 | S3 의 임시 조건(`heap.level !== 'ok' && heap.journalBytes > 0`)을 `decideSave(plan, journalAdvice)` 의 `advised` 로 바꿨다. warn 은 확인 창 안내, over-limit 은 중단 문구에 덧붙임 |
| 지원 크기 안내 | 열 때 `OpenResult.byteLength > SUPPORTED_INPUT_BYTES`(828,375,040 B = 790 MiB)이면 알림 줄 `supported-size`. S3 의 저장 전 판정 기반 안내(`size`)는 그대로 둔다 |
| 정보 대화상자 | "매우 큰 문서(수백 MB, 수천 쪽)" 문구를 실제 값 "약 790 MiB 까지(이미지 위주 문서 기준)" 로 |
| 값 정정 | `save-method.ts` 주석 "약 690 MiB" → 790 MiB(계산값과 `docs/m5-heap.md` 6절에 맞춤). `docs/user/limits.md` 의 M0 배율 경계(441·589 MiB)를 S1 모델 기준(790 MiB, 1,536/2,048 MiB, 저널 안내)으로 |

시험:

| 시험 | 내용 |
| --- | --- |
| `core/test/journal-rpc.test.ts`(새) 3건 | RPC 응답 = 세션 판정, 커밋 뒤 저널 증가, 문서 없음 예외, index·client 재export 값 일치(790 MiB) |
| `extension/test/about.test.ts` | `decideSave` 가 `advised` 만 따름(힙 수준·`journalBytes` 무관), `journalNotice` 문구, `supportedSizeNotice` 경계, 정보 대화상자 값 |
| `extension/test/recovery.test.ts` 1건 | `journalAdvice` 치명 오류 → 복구 → 새 Worker 에서 재시도 |
| e2e `edit-integration.spec.ts` 1건 | 실제 Worker 판정(커밋 뒤 `journal-advice` 진단: `journalBytes > 0`, `advised: false`, 알림 없음) → 값 주입(`advised: true`) 뒤 두 번째 커밋에서 알림 줄 표시 |
| e2e `extension-save.spec.ts` 1건 | 작은 문서 알림 없음, `open` 응답의 `byteLength` 를 800 MiB 로 주입하면 지원 크기 알림 |

## 3. 정합 점검

### 3.1 벤치 항목과 스토어 빌드(D6)

| 확인 | 결과(수정 전) | 처리 |
| --- | --- | --- |
| `vite.config.ts` bench 입력 | 스토어 빌드에도 `bench.html`·`bench-*.js`·`bench-*.css` 출력, 스테이징·zip 포함 | bench 입력을 dev 빌드에만 둔다 |
| `viewer.html` `#open-bench` | 스토어 빌드에 링크 존재(숨김 `#diag` 안) | 스토어 빌드의 `transformIndexHtml` 에서 링크 제거 |
| `#bench-full-save` | `#diag` 안이라 CSS 로 숨김 | 그대로(D6: DOM 유지·숨김) |
| `verify-dist --release` | 벤치 파일을 검사하지 않음 | `bench*.html/js/css` 파일과 `bench.html`·`id="open-bench"` 참조가 있으면 실패. 수정 전 설정으로 패키지하면 "벤치 파일 포함: assets/bench-….css, assets/bench-….js, bench.html", "벤치 페이지 참조: viewer.html" 로 실패함을 확인 |
| release-smoke e2e | — | `#open-bench` 없음 확인 추가 |

### 3.2 스크롤 상자(`#page-container`)

S3 가 창 스크롤을 `#page-container` 스크롤로 옮긴 뒤 window 스크롤 가정을 조사했다(`scrollY`·`scrollTo`·`pageYOffset`·`innerHeight`·`documentElement.client*`·`scroll` 리스너).

| 대상 | 결과 | 처리 |
| --- | --- | --- |
| 편집기·텍스트 층·표시·패스 층 위치 | 모두 `getBoundingClientRect()` 와 `clientX/Y`(뷰포트 기준) | 변경 없음 |
| 찾기 스크롤 | `scrollIntoView` 가 가장 가까운 스크롤 조상을 움직임 | 실제 뷰어 e2e 추가(`toolbar-layout.spec.ts`): 아래쪽 고유 단어 검색 시 `#page-container.scrollTop > 0`, 창 `scrollTop = 0`, 툴바 화면 안 |
| 쪽 넘김 | viewer-ui 에 스크롤 조작 없음(이전과 같음) | 변경 없음 |
| S5 패스 UI | `PathLayer` 는 `getBoundingClientRect` 기준 | 변경 없음 |
| S2 벤치 페이지 | `viewer.css` 의 `body { overflow: hidden }` 를 함께 써서, 설정 패널이 창보다 길면 실행·내보내기 버튼에 닿을 수 없음. 사용 폭은 `documentElement.clientWidth` | `bench.css`: 패널 `flex: none; max-height: 45vh; overflow: auto`. `bench.ts`: 사용 폭을 뷰어와 같이 `#page-container.clientWidth`(상한 1100 은 유지, 서버 1280 px 에서는 값 변화 없음) |
| `viewer-ui.spec.ts` 의 `window.scrollY` | viewer.css 를 쓰지 않는 하니스 페이지라 창 스크롤이 맞음 | 변경 없음 |

### 3.3 문서 변경 시 캐시 무효화

| 캐시 | 무효화 경로 | 확인 |
| --- | --- | --- |
| S2 렌더 캐시(뷰어) | 문단·패스 커밋, undo·redo, 복구 → `invalidatePages`(해당 쪽 전 배율 삭제 + epoch 증가). Worker 복구 → `clear()`. 새 문서 → 새 `ViewerController` | 시험 2건 추가(`render-cache.test.ts`): 복구 뒤 전 쪽 재렌더, 미리 렌더 중 무효화된 쪽은 담지 않음(epoch) |
| core 쪽 캐시(추출·SourceMap·레이아웃·연결) | 편집 엔진이 `invalidateAround`(해당 쪽, 레이아웃 ±2쪽) | 기존 시험 |
| S1 문서 통계 | 첫 전체 렌더 뒤 1회 예약, 문서를 닫을 때까지 보관(D5 "한 번 계산"). 편집으로 생긴 객체는 저널 추정이 덮는다. 복구 시 새 세션이 다시 계산(렌더 캐시 `clear()` 로 새 Worker 에 전체 렌더가 간다) | 의도대로. 편집마다 재계산하지 않는 것은 계약 D5 그대로 |
| S5 `pageUseCache` | 판정 ctx(호출 = revision) 키라 문서 변경 뒤 새 판정에 옛 값 없음 | 기존 시험(`path-edit.test.ts`) |
| 패스 모델(뷰어) | `invalidatePages` 가 `path.model` 을 idle 로, 커밋 뒤 `ensureModel`·`replan` | 기존 시험 |

## 4. 검증

### 4.1 명령별 결과(최종 HEAD, 2026-10-21)

| 명령 | 결과 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 성공(잠금 파일 변경 없음) |
| `pnpm exec turbo run build typecheck test test:e2e --force` | 25/25 작업 성공, 캐시 0 |
| 단위 시험(위 실행 안) | shared-types 4, layout-recon 60(+3 건너뜀), reflow 60, pdf-ops 450(+5), core 287(+5), viewer-ui 300, extension 72, spike-m0 33(+1). 합계 1,266 통과, 14 건너뜀(코퍼스·옵트인) |
| e2e | 139 통과, 5 건너뜀(옵트인: 코퍼스 메모리, 벤치 정식 실행, DNR 128–150 실측, 편집 반응 정식 측정, 패스 끌기 정식 측정). 연속 3회(turbo 1회 + `pnpm --filter @pdf-editor/extension test:e2e` 2회) 모두 139 통과 |
| `pnpm lint` | 오류 0 |
| `pnpm exec prettier --check .` | 통과 |
| `pnpm --filter @pdf-editor/extension package` | 성공(끝에서 `verify-dist --release` 자동 실행) |
| `node apps/extension/scripts/verify-dist.mjs --release` | `release OK` |

### 4.2 간헐 실패와 수정

| 시험 | 증상 | 원인 | 수정 | 확인 |
| --- | --- | --- | --- | --- |
| `bench-memory.spec.ts` 합성 60쪽 | 탭 증가 178·183 MiB > 150 MiB 로 실패(4회 중 2회) | 종료 직후 VmRSS 는 수거 전 JS 쓰레기 양(종료 시 JS 힙 36–109 MiB)에 따라 96–183 MiB 로 흔들림. 강제 GC 뒤 증가는 54–87 MiB | 탭 증가 단언을 강제 GC 뒤 값(`tabDeltaAfterGcMiB`)으로. 종료 직후 값은 로그 기록만. WASM 증가 ≤ 64 MiB 단언(계약 4.1 의 서버 시험 대상)은 그대로 | 3회 연속 통과(GC 뒤 54·58·73 MiB) |
| `path-integration.spec.ts` "점 편집·삭제·선 두께" | `#pe-path-fill` 비활성(채움 대신 선이 선택된 채). `docs/m5-release.md` 9절 #9 와 같은 증상 | 선 두께 커밋 직후 쪽을 다시 그리고 판정을 다시 받는 동안(약 100 ms) `PageSurface` 가 `PathLayer` 를 내려 Alt+클릭이 무시된다. 판정 뒤 이전 선택(선)의 상자가 다시 보여 `altSelect` 가 "상자 보임" 으로 성공 처리. 단독 20회 중 7회 재현 | `altSelect` 가 먼저 `loading=false`·쪽 판정 ready·`settling=false` 를 기다린 뒤 누른다 | 패스 통합 5건 × 15회 75/75, 전체 e2e 3회 연속 통과 |

- 두 번째 원인의 제품 동작(커밋 직후 약 100 ms 동안 Alt+클릭 무시)은 리뷰 대응에서 고쳤다(8.2 M8). 위 e2e 대기는 뺐다.

## 5. 패키지

| 항목 | 값 |
| --- | --- |
| zip | `apps/extension/out/release/pdf-editor-1.0.0.zip` 7,154,121 B(6.82 MiB, 상한 15 MiB), sha256 `b72f8e0ec2d4d69639da671d24cbbaf23fc636b09e67a97ec4a47a5ef89eecd8` |
| 스테이징 | 15,683,421 B(14.96 MiB, 상한 25 MiB) |
| 소스맵 zip | 614,320 B(릴리스 자산, 업로드 zip 에 미포함) |
| 결정성 | C7·벤치 제외 커밋 뒤 두 번 만든 zip 의 sha256 동일 |
| S3 기록 대비 | zip +4,209 B(7,149,912 → 7,154,121). S3 기록은 S1·S2 머지 전 `m5-release` 기준. 벤치 파일은 제외됨 |

## 6. 계약과 다른 점·결정 필요

| # | 내용 | 상태 |
| --- | --- | --- |
| I1 | pdf-ops `package.json` 에 하위 경로 `./save-method` 를 더했다(뷰어가 MuPDF 없이 상한 값을 가져오기 위함). 새 의존성·잠금 파일 변경 없음 | 메인 세션 확인 |
| I2 | 메모리 왕복 e2e 의 탭 증가 단언을 강제 GC 뒤 값으로 바꿨다. D1 의 탭 메모리 목표 정의(측정 시점)는 바꾸지 않았다. Windows 판정 정의는 남은 일 #3 | 메인 세션 확인 |
| I3 | 지원 크기 안내는 열 때 바이트 기준(`supported-size`)과 저장 전 판정 기준(`size`) 두 알림이 함께 날 수 있다. 문구 통합 여부 | 메인 세션 결정 |

## 7. 남은 일

| # | 내용 | 담당 |
| --- | --- | --- |
| 1 | D4 체크포인트 도입 여부. 재적용 2 s 기준을 1.2 MB 쪽 5건 안팎, 8.9 MB 쪽 1건에서 넘는다(`docs/m5-heap.md` 5.3·8절 C8) | 메인 세션 결정 |
| 2 | 재적용 실패 2건(R4): zen-ko-report-21333257 6쪽 20건 중 7번째, kogl-mods-cpi-202609 9쪽 100건 중 89번째 "재적용 대상 문단을 찾지 못함". Worker 복구 경로 결함 | 후속(복구 경로) |
| 3 | 쪽 판정 1.0 s: 서버 최대 패스 쪽 콜드 1.05 s, 재진입 306 ms(목표 200 ms). Windows 에서 넘으면 대체안(패스 판정 지연)과 shared-types 변경 필요(`docs/m5-perf.md` 7절 #3) | 메인 세션 결정 |
| 4 | 메모리 목표 정의: 서버에서 WASM 증가 64 MiB 를 4/8, 탭 증가 150 MiB 를 7/8 문서에서 넘음(캐시·수거 가능 쓰레기). Windows 값 회신 뒤 목표 값 또는 측정 시점(GC 뒤 등) 재정의(`docs/m5-perf.md` 7절 #4, I2) | 메인 세션 결정 |
| 5 | 100 MB 이상 실제 문서 2건(이미지 위주·객체 위주) 확정, `heap-run.mjs` 검증·Chrome Worker 1회, 벤치 `large-real-*` 항목 채움(현재 합성 대체) | 메인 세션 → S1·S2 후속, 출처·라이선스 사람 확인 |
| 6 | Windows 확인: 압축해제 `dist` 측정 페이지 실행·탭 메모리 수동 입력·결과 JSON 회신, 대용량 문서 Chrome Worker 1회, 설치 안내대로 설치 후 M4 기능 확인, 실제 툴바 Ctrl +/−·Ctrl+휠 확대에서 툴바 고정·버튼 화면 안(서버는 CDP 에뮬레이션으로 대신함), 지원 크기·저널 안내 표시 | 사용자 |
| 7 | 스토어: 매니페스트 이름·설명 승인, 릴리스 태그 `v1.0.0`(소스 링크 유효 조건), 대시보드 초안 업로드 확인, 서드파티 고지 법적 검토(`docs/m5-release.md` 9절) | 사용자·메인 세션 |
| 8 | ~~편집 커밋 직후 쪽 재판정 동안 Alt+클릭 무시~~ 리뷰 대응에서 처리(8.2 M8) | 완료 |
| 9 | OOB 감시 200회 릴리스 전 재실행(`docs/m5-perf.md` 7절 #7) | 사용자·메인 세션 |

## 8. 마일스톤 리뷰 대응(2026-10-21, 판정 REVISE)

### 8.1 커밋

| 커밋 | 내용 |
| --- | --- |
| 3ec498e | M1 객체 스트림 전수, 합성 `large-objstm-4000` |
| 8b90d99 | H1·M2 저장 힙 모델 `step-v2`(core·pdf-ops·shared-types) |
| 20ce8b1 | H1·M2 뷰어 저장 전 판정 문구·"그래도 저장 시도" |
| 1184969 | H1 벤치: 같은 세션 저장 2회 시나리오 |
| 2352fbe | M8 패스 커밋 직후 Alt+클릭 보류 |
| 0dcae46 | M7 메모리 왕복 e2e 정정 |
| a7389d7 | M5 URW 글꼴 고지 |
| (이 커밋) | 문서: M3·M6·L6, `docs/m5-heap.md` 4.4·4.5, 이 절 |

### 8.2 지적별 처리

| # | 지적 | 처리 | 근거·결과 |
| --- | --- | --- | --- |
| H1 | 두 번째 저장 거짓 차단(줄지 않는 선형 메모리를 사용 중으로 셈) | 처리 | 모델 `step-v2`: 사용 중 힙 = 직전 저장의 사용 추정 + 저장 뒤 늘어난 힙, 두 번째 저장부터 저장 전 `emptyStore()`. over-limit 근거가 커진 힙이면 "그래도 저장 시도". 같은 세션 저장 2회 312회 미탐 0, Chrome Worker 7건 미탐 0(`docs/m5-heap.md` 4.4). 525 MiB 재현: 예상 2,279 → 1,404 MiB, 실측 898 |
| M1 | 표본 통계의 ObjStm 과소 추정 | 처리 | xref 에서 객체 스트림 번호를 읽어 전수. 잘못된 주석 정정. 합성 `large-objstm-4000` 에서 이전 방식 −11–12%, 새 방식 = 전수, 미탐 0(`docs/m5-heap.md` 4.5) |
| M2 | 차단 문구 모순·중복 | 처리 | 중단 상태에서 "저장 후 다시 열기" 권고 제거, 다시 열면 저장하지 않은 편집이 사라짐을 안내. 힙 문구에서 권고를 빼 중복 제거. 되돌리기는 저널 추정을 줄이지 않아(되돌린 단계도 다시 실행 기록으로 메모리에 남음) 권하지 않았다 |
| M3 | `docs/user/limits.md` 수치 | 처리 | 영어 요약 790 MiB·1,536/2,048 MiB. 알려진 제한: Alt+클릭(M8 뒤 상태), 쪽 판정 서버 콜드 1.05 s |
| M4 | 진단값 노출 | 미처리 | 범위 밖으로 남김(지시) |
| M5 | URW 글꼴 고지 | 처리 | mupdf 1.28.1 태그 `resources/fonts/urw/OFL.txt`(SIL OFL 1.1, 2026-10-21 GitHub 에서 확인). `third-party-extra.json` 항목·`licenses/mupdf-urw-OFL.txt`, `verify-dist` 가 `(URW)++` 확인 |
| M6 | PLAN.md 반영 | 처리 | v2.15: 2절 폰트 크기, 5.1 D7, 5.4 렌더 캐시·D5·지원 크기, 6절 M5 행, 7절 리스크 3·8, 8절 성능 축 D1, 11절, M0 DoD 가로채기 행 |
| M7 | 메모리 왕복 e2e 이름·주석 | 처리 | "회귀 감시(합성 60쪽)", DoD 고정 주장 삭제, 종료 직후 탭 증가 ≤ 250 MiB 단언 추가 |
| M8 | 커밋 직후 약 100 ms Alt+클릭 | 처리 | 재판정 중 선택 상자 숨김, 클릭 보류 뒤 처리, `PathLayer` 상시 마운트. e2e 대기 제거, 회귀 e2e(판정 400 ms 지연, 한 번 클릭) 수정 전 3/3 실패·수정 뒤 15/15 통과 |
| L1 | `verify-dist` 가 선택 권한·content_scripts·externally_connectable 키, 번들 원격 코드 패턴, extra 항목 이름을 검사하지 않음(직접 스캔은 깨끗) | 미처리 | 후속(검사 보강) |
| L2 | release-smoke 에 스토어 빌드 임베디드(`<embed>`·`<iframe>`·`<object>`) 시험 없음(수동 3/3 렌더) | 미처리 | 후속 |
| L3 | 스토어 빌드에 `?file=` 경로(`credentials: 'include'`) 잔존, WAR 없어 웹에서 닿지 않음 | 미처리 | 후속(스토어 빌드에서 무시) |
| L4 | `openFromBuffer` 열기 예외 시 임시 Buffer 가 GC 전까지 남음(Buffer 입력은 측정용) | 미처리 | 후속 |
| L5 | 객체 수가 매우 많은 문서는 첫 렌더 직후 통계 계산으로 Worker 약 0.6–0.8 s 점유, 열람만 해도 힙 23–57 MiB 추가 | 미처리 | 후속 |
| L6 | README 결과 표 시험 수 | 처리 | 8.4 검증 실행 값 |
| L7 | `companionPoints` 가 좌표만으로 동행 제어점을 판정해, 같은 좌표에 겹친 다른 꼭짓점의 제어점도 옮길 수 있음(PLAUSIBLE) | 미처리 | 후속(꼭짓점 인덱스로 판정) |

### 8.3 계약과 다른 점·결정 필요

| # | 내용 |
| --- | --- |
| R1 | shared-types `SaveHeapEstimate` 에 선택 필드 `usedHeapBytes`·`priorSavePeakBytes`·`grownHeapBasis` 를 더했다(계약 3절: 메인 세션 승인 대상) |
| R2 | 계약 D5 식의 "현재 `wasmHeapBytes`" 를 "사용 중 힙" 으로 바꿨고 두 번째 저장부터 저장 전 MuPDF 자원 캐시를 비운다(`docs/m5-heap.md` 8절 C10) |
| R3 | M2 예시의 "되돌리기로 편집 줄이기" 는 안내하지 않았다. 저널 추정·실제 메모리 모두 되돌리기로 줄지 않는다 |
| R4 | "그래도 저장 시도" 는 over-limit 이고 `grownHeapBasis` 일 때만 둔다. 측정에서 해당 표본은 1건(합성 이미지 1,000쪽 전체 보기 30, 두 번째 저장 성공) |

### 8.4 검증(코드 최종 커밋 a7389d7, 2026-10-21)

| 명령 | 결과 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 성공(잠금 파일 변경 없음) |
| `pnpm exec turbo run build typecheck test test:e2e --force` | 25/25 작업 성공, 캐시 0 |
| 단위 시험 | shared-types 4, layout-recon 60(+3), reflow 60, pdf-ops 451(+5), core 290(+5), viewer-ui 302, extension 74, spike-m0 33(+1). 합계 1,274 통과, 14 건너뜀 |
| e2e | 1회째(turbo) 141 통과·5 건너뜀, 2회째(`pnpm --filter @pdf-editor/extension test:e2e`) 141 통과·5 건너뜀 |
| `pnpm lint` | 오류 0 |
| `pnpm exec prettier --check .` | 통과 |
| `pnpm --filter @pdf-editor/extension package` + `verify-dist --release` | 성공, `release OK`. zip 7,155,754 B(6.82 MiB, 상한 15 MiB, sha256 `49238c59…`), 스테이징 15,692,018 B(상한 25 MiB), 소스맵 zip 620,607 B. 직전 기록 대비 zip +1,633 B(URW 고지·코드 변경). `THIRD_PARTY_NOTICES.txt` 에 `(URW)++` 포함 |

## 9. main 병합 시점 상태(2026-10-21)

### 9.1 사용자 승인

- 8.3 R1–R4 를 승인한다(사용자 결정 2026-10-21). shared-types `SaveHeapEstimate` 선택 필드 3개, 계약 D5 의 "사용 중 힙"·두 번째 저장 전 캐시 비우기(C10), 차단 안내에서 되돌리기 권고 제외, "그래도 저장 시도" 범위(over-limit 이고 `grownHeapBasis`).
- 미충족 DoD 를 명시한 채 main 에 병합한다.

### 9.2 DoD 축별 상태(계약 1.1)

| 축 | 상태 | 근거·남은 것 |
| --- | --- | --- |
| 성능 기준 | **미충족** | 하네스·서버 기록 완료(`docs/m5-perf.md`). Windows 기준 PC 측정 미회신. 서버 쪽 판정 최대 패스 쪽 콜드 1.05 s(목표 1.0 s), 대체안 결정 대기 |
| Windows 실행 | **미충족** | 측정 페이지 준비 완료, 사용자 실행·JSON 회신 대기 |
| 저장 힙 | 부분 충족 | 미탐 0(저장 1회·2회, Chrome Worker 포함). 과탐은 문서 기준이면 충족, 시나리오 기준이면 미달(heap C4). 기준 결정 대기 |
| 대용량 | **미충족** | 합성 대체로만 확인(Chrome Worker 포함, 탭 크래시 0). 100 MB 이상 실제 문서 미확정 |
| 메모리 | **미충족** | 서버에서 WASM 증가 64 MiB 를 4/8, 탭 증가 150 MiB 를 7/8 문서가 넘는다(캐시·미수거). 목표 값·측정 시점 재정의 대기. e2e 는 회귀 감시만 |
| 배포 | 부분 충족 | 스토어 zip·`verify-dist --release`·스테이징 스모크 통과. 대시보드 초안 업로드(사용자), `mime_types_handler` 수용 확인, `v1.0.0` 태그, 고지 법적 검토 대기 |
| 문서 | 충족(공개 URL 제외) | 사용자·스토어·저장소 문서 작성. 개인정보 처리 방침 공개 URL 은 태그·공개 뒤 |
| 정리 | 충족 | M4 후속 L2·L3·L5·L7·L8, 첫 Alt+클릭 소실(`docs/m4-integration.md` 9절), 커밋 직후 Alt+클릭(M8) |
| 회귀 | 충족 | 8.4 |

### 9.3 후속

- 결정: D4 체크포인트, 쪽 판정 1.0 s 대체안, 메모리 목표 정의, 과탐 기준, I1–I3.
- 수정: 재적용 실패 2건(R4), M4 진단값 노출, L1–L5·L7, OOB 200회 재실행.
- 사용자: Windows 측정, 100 MB 이상 실제 문서 확정, 대시보드 업로드, 이름·상표 확인, `v1.0.0` 태그 push.
