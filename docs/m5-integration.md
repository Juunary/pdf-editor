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
| I3 | 지원 크기 안내는 열 때 바이트 기준(`supported-size`)과 저장 전 판정 기준(`size`) 두 알림이 함께 날 수 있다. 문구 통합 여부 | 사용자 결정 2026-10-21: 한 칸으로 통합, 반영(`docs/m5-followup.md` 6절) |

## 7. 남은 일

| # | 내용 | 담당 |
| --- | --- | --- |
| 1 | ~~D4 체크포인트 도입 여부~~ 사용자 결정 2026-10-21: 저장 시점 기준점 + 진행 표시, 반영(`docs/m5-followup.md` 3절) | 완료 |
| 2 | ~~재적용 실패 2건(R4)~~ 수정(`docs/m5-followup.md` 2절). 원 기록: zen-ko-report-21333257 6쪽 20건 중 7번째, kogl-mods-cpi-202609 9쪽 100건 중 89번째 "재적용 대상 문단을 찾지 못함". Worker 복구 경로 결함 | 후속(복구 경로) |
| 3 | 쪽 판정 1.0 s: 서버 최대 패스 쪽 콜드 1.05 s, 재진입 306 ms(목표 200 ms). Windows 에서 넘으면 대체안(패스 판정 지연)과 shared-types 변경 필요(`docs/m5-perf.md` 7절 #3) | 사용자 결정 2026-10-21: Windows 중앙값 초과 시 대체안 구현 사전 승인. Windows 측정 대기 |
| 4 | 메모리 목표 정의: 서버에서 WASM 증가 64 MiB 를 4/8, 탭 증가 150 MiB 를 7/8 문서에서 넘음(캐시·수거 가능 쓰레기). Windows 값 회신 뒤 목표 값 또는 측정 시점(GC 뒤 등) 재정의(`docs/m5-perf.md` 7절 #4, I2) | 사용자 결정 2026-10-21: 목표값 유지, 끝 = `emptyStore` 뒤·30 s 뒤. 재측정 WASM 7/8·탭 6/8(`docs/m5-followup.md` 4절) |
| 5 | 100 MB 이상 실제 문서 2건(이미지 위주·객체 위주) 확정, `heap-run.mjs` 검증·Chrome Worker 1회, 벤치 `large-real-*` 항목 채움(현재 합성 대체) | 메인 세션 → S1·S2 후속, 출처·라이선스 사람 확인 |
| 6 | Windows 확인: 압축해제 `dist` 측정 페이지 실행·탭 메모리 수동 입력·결과 JSON 회신, 대용량 문서 Chrome Worker 1회, 설치 안내대로 설치 후 M4 기능 확인, 실제 툴바 Ctrl +/−·Ctrl+휠 확대에서 툴바 고정·버튼 화면 안(서버는 CDP 에뮬레이션으로 대신함), 지원 크기·저널 안내 표시. **2026-10-22 회신(W1–W6)**: 결과·미확인 항목은 9.2. W2 수정 뒤 메모리 재측정 필요 | 사용자 |
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
| 성능 기준 | **미충족**(판정 기준 결정 대기) | 2026-10-22 Windows 회신(W1, 아래). p95 기준 초과 4건: nasa-se-handbook 편집 153 ms, arxiv-2609.10511 편집 114 ms, kogl-mods-cpi-202609 쪽 판정 첫 진입 1,276 ms·재진입 491 ms. 중앙값 기준 초과 1건: nasa-se-handbook 편집 118 ms. 계약 D1 목표는 p95 이고 쪽 판정 대체안 조건(사용자 결정 2026-10-21)은 중앙값이다: 중앙값 최대 247·87 ms 라 대체안 조건은 충족하지 않는다. **성능 합격 기준(중앙값·p95) 사용자 결정 대기** |
| Windows 실행 | 회신(2026-10-22), **재측정 필요** | W1–W6 회신(아래). 결과 JSON 은 사용자 PC 에 있고 서버에는 없다(아래 값은 회신 원문). W2 수정 뒤 새 `dist` 로 메모리 재측정 필요 |
| 저장 힙 | 충족 | 미탐 0(저장 1회·2회, Chrome Worker 포함). 과탐 문서 기준 채택(사용자 결정 2026-10-21, 계약 4.2): 전체 0%·증분 5%. 시나리오 기준(15%·48%)은 기록만 |
| 대용량 | **미충족** | 합성 대체로만 확인(Chrome Worker 포함, 탭 크래시 0). 100 MB 이상 실제 문서 미확정 |
| 메모리 | **미충족** | 측정 시점 확정(사용자 결정 2026-10-21: WASM `emptyStore` 뒤 사용 중 힙, 탭 30 s 뒤). Windows W2: kogl-mods-cpi-202609 WASM 104.9 MiB 실패(측정), 탭 1차 무효·2차 초과(추정), kogl-nabo-finstmt2025·nist-sp800-53r5 WASM 통과. WASM 원인(되돌리기 저널이 풀린 쪽 콘텐츠를 편집마다 보관) 수정: 서버 같은 시나리오 105.2 → 24.3 MiB(`docs/m5-followup.md` 5.1). 탭 증가는 서버 수정 뒤에도 573 MiB(30 s 뒤)로 미충족, 대부분 현재 쪽(9쪽) core 캐시(Worker JS 약 469 MiB)라 대응 결정 대기(5.2). Windows 재측정 대기. synthetic-objects-2000 탭 170.6 MiB(서버) 그대로 |
| 배포 | 부분 충족 | 스토어 zip·`verify-dist --release`·스테이징 스모크 통과. W5 스토어 빌드 확인 통과(사용자 보고 2026-10-22, 세부 미수신). 대시보드 초안 업로드(W6 미실시), `mime_types_handler` 수용 확인, `v1.0.0` 태그, 고지 법적 검토 대기 |
| 문서 | 충족(공개 URL 제외) | 사용자·스토어·저장소 문서 작성. 개인정보 처리 방침 공개 URL 은 태그·공개 뒤 |
| 정리 | 충족 | M4 후속 L2·L3·L5·L7·L8, 첫 Alt+클릭 소실(`docs/m4-integration.md` 9절), 커밋 직후 Alt+클릭(M8) |
| 회귀 | 충족 | 8.4 |

**Windows 기준 PC 확인 회신(2026-10-22, 확인 항목 W1–W6)**. 근거 표기: 측정(결과 JSON 값, 사용자 집계 포함), 사용자 보고(사용자가 직접 확인, 세부 미수신), 추정(해석·가정), 미확인(사유).

| 항목 | 값 |
| --- | --- |
| 환경(사용자 보고) | Chrome 155.0.8059.82 공식 빌드, Windows 11 Home 10.0.26200, Intel Core Ultra 5 228V(브라우저 보고 8코어), RAM 31.5 GiB(브라우저 보고 `deviceMemory` 32), devicePixelRatio 2, 뷰포트 1440×731. 개발 빌드(PDF Editor (dev) 1.0.0, `dist` 44개 파일)와 스토어 빌드(PDF Editor 1.0.0, 스테이징 22개). 측정 중 전원 연결 여부는 미확인(준비 시점에는 배터리 방전 상태로 보였음). 검증일 2026-10-21~22(KST) |
| W1 성능·쪽 판정 | 측정, `m5-bench-2026-10-21T13-28-37-195Z.json`(7문서, 개발 빌드, 약 4분). 아래 표 |
| W2 메모리 왕복 | 측정 + 추정. 아래 |
| W3 툴바 확대·창 크기 | 단계 a–e 통과(사용자 보고, 스크린샷·세부 값 미수신) |
| W4 복구 진행 표시 | 통과(사용자 보고). `__seen` 출력·복구 시간·`worker-recover-source` 진단 줄 미수신 |
| W5 스토어 빌드 | 통과(사용자 보고, 항목 a–g 별 세부 미수신) |
| W6 대시보드 업로드 | 하지 않음(미확인: 선택 항목, 개발자 계정 사용 여부 미확인) |

W1(값은 p95 ms, 굵게 = p95 기준 초과):

| 문서 | 쪽 | 열기 | 쪽 넘김(전체) | 편집 | 패스 | 저장(편집 후) |
| --- | --- | --- | --- | --- | --- | --- |
| arxiv-2609.09268 | 16 | 155 | 64 | 16 | 45 | 153 |
| arxiv-2609.10511 | 15 | 69 | 199 | **114** | 측정 실패 | 98 |
| kogl-mods-cpi-202609 | 26 | 103 | 198 | 33 | 39 | 79 |
| kogl-nabo-finstmt2025 | 179 | 233 | 54 | 59 | 44 | 216 |
| nasa-se-handbook-sp2016-6105 | 297 | 1,055 | 287(점프만 349) | **153** | 39 | 494 |
| nist-sp800-53r5 | 492 | 95 | 55 | 31 | 33 | 491 |
| zen-beamer-7535020 | 81 | 46 | 45 | 11 | 33 | 66 |
| 목표(D1) | | 1,500 | 300 | 100 | 150 | 3,000 |

- 쪽 판정(목표 첫 진입 1,000·재진입 200 ms): p95 기준 kogl-mods-cpi-202609 초과(첫 진입 **1,276**·재진입 **491** ms). 다른 문서의 판정 p95 값은 회신 원문에 없다(초과 보고 없음). 중앙값 기준은 전 문서 통과(첫 진입 최대 247·재진입 최대 87 ms, 측정).
- 표본 수: 열기 5, 저장 3(편집 전·후 각각), 쪽 판정 6(첫 진입·재진입 각각)은 nearest-rank p95 가 최댓값이다(표본 20 미만). 저장·쪽 판정·열기의 p95 는 사실상 최댓값이다. 쪽 넘김은 30(순차 20 + 점프 10), 편집은 30 이하(입력이 몰리면 마지막 입력만 보내 표본이 준다, nasa 25), 패스는 40.
- 판정 비교: p95 기준 초과 4건(arxiv-2609.10511 편집 114, nasa 편집 153, kogl 쪽 판정 1,276·491). 중앙값 기준 초과 1건(nasa 편집 중앙값 118). nasa 쪽 넘김은 지표(순차 + 점프 합친 p95 287)로는 통과이고 점프만 보면 349 로 넘는다. 어느 기준으로 판정할지는 사용자 결정 대기다.
- kogl-mods-cpi-202609 쪽 판정 초과는 첫 표본에서 나온다: 첫 진입 1,276·864 뒤 270 이하, 재진입은 첫 표본 491 뒤 72 이하(측정). 하네스는 이 문서에서 쪽을 [4, 8, 12, 16, 20, 24]쪽 순서로 재므로(0부터 3, 7, …) 1,276 은 4쪽(최대 패스 쪽), 864 는 8쪽이다(추정: 회신 JSON 에는 쪽 번호가 없어 하네스 순서 계산으로 맞춤). 서버 브라우저에서 같은 순서로 1,106·596 ms, Node 에서 순서를 바꿔도 4쪽 779–1,145·8쪽 765–827 ms 라 쪽에 따른 값이고 첫 실행 준비 시간이 아니다(측정, `docs/m5-perf.md` 7절 #3). 8쪽은 레이아웃이 이웃 9쪽(풀린 콘텐츠 8.9 MB)을 추출해 느리다.
- nasa-se-handbook 편집 반응: 표본 25개 전부 73–181 ms, 중앙값 118 ms(측정). 열기 1,055 ms 는 첫 쪽 렌더 518 ms(M2 확인)와 맞는다. 원인 가설·제안은 `docs/m5-perf.md` 7절 #8(수정하지 않음).
- arxiv-2609.10511 편집 p95 114 는 첫 세 표본(133·114·59 ms)이 만들고 이후 10 ms 대(중앙값 11, 측정). 첫 편집 준비(폴백 폰트 적재 등)로 추정(미확인).
- 그 밖: kogl-mods-cpi-202609 연속 쪽 넘김 중 1회 1,656 ms(단발, p95 에 안 잡힘, 측정). arxiv-2609.10511 패스 "패스 선택·판정 실패"는 하네스 결함(가운데를 눌러 원 모양 선 패스를 고르지 못함)이라 고쳤다(서버 p95 32 ms, `docs/m5-perf.md` 1.2).

W2(기준 WASM 사용 중 힙 증가 ≤ 64 MiB, 탭 증가 ≤ 150 MiB):

| 실행 | 문서 | WASM 증가 MiB(판정) | 선형 메모리 증가 MiB | 탭 | 판정 |
| --- | --- | --- | --- | --- | --- |
| 1차 `m5-bench-2026-10-21T13-37-55-903Z.json` | kogl-mods-cpi-202609 | **104.9** | 163.4 | 무효 | WASM 실패 |
| 1차 | kogl-nabo-finstmt2025 | 15.7 | 47.3 | 무효 | WASM 통과 |
| 1차 | nist-sp800-53r5 | 27.6 | 62.1 | 무효 | WASM 통과 |
| 2차 `m5-bench-2026-10-21T13-44-25-747Z.json` | kogl-mods-cpi-202609 | **104.9375** | 선형 199,098,368 B(1차와 같음) | 약 +717 MiB(추정) | WASM 실패, 탭 실패(추정) |

- 측정: 2차는 1차와 바이트까지 같은 값으로 결정적으로 재현했다. 사용 중 힙 9,240,576 → 119,275,520 B, 30초 정착·GC 뒤에도 같다. 페이지 JS 힙 39.8 → 93.9(이동 뒤) → 75.0(편집 뒤) → 74.4 MiB.
- 탭(1차): 입력값이 세 문서·모든 시점에서 42420 으로 같아 증가 0 → 무효(새로 읽지 않은 값으로 추정, 값이 K 단위로 보임).
- 탭(2차): 입력 기준 272940, 종료 직후 10007300, 30초 뒤 1007300. 단위는 사용자에게 확인받지 못했다(미확인). Chrome 작업 관리자의 K 로 보면 기준 약 266.5 → 30초 뒤 약 983.7 MiB, 증가 약 717 MiB(추정, 종료 직후 값은 0 하나가 더 붙은 입력 실수로 추정해 뺌). 하네스가 이 값을 MiB 로 읽어 `tabDeltaMiB` 734360 으로 기록했다: 숫자는 틀리고 결론(초과)은 같다. 입력란은 K·MiB 단위·경고를 갖도록 고쳤다(`docs/m5-perf.md` 1.3).
- `firstSavePeakHeapBytes` 가 모든 실행에서 시작 힙과 같았던 것은 하네스가 기준점 선형 메모리를 그 필드에 그대로 넣었기 때문이다(같은 변수). 저장 전 선형 메모리·D5 예상 피크를 따로 남기도록 고쳤다(`docs/m5-followup.md` 5.1).
- 원인·수정: 9쪽(풀린 8.9 MB) 문단 첫 편집 10건마다 쪽 콘텐츠 전체가 저널에 남았다(서버 저널 추정 93.8 MiB). 커밋 때 Flate 압축으로 서버 같은 시나리오 105.2 → 24.3 MiB(`docs/m5-followup.md` 5.1). 탭은 5.2.

미확인 목록(사유):

| # | 항목 | 사유 |
| --- | --- | --- |
| 1 | W1 4쪽(최대 패스 쪽) 판정 값 | 회신 JSON 에 쪽 번호가 없다(첫 진입 첫 표본 1,276 ms 가 4쪽인 것은 하네스 순서로 추정). 4쪽 단계 분해는 수동 실행에 지정 쪽이 빠져 13·22쪽만 기록됨 → 하네스 수정(수동 실행도 4쪽 포함, 표본 쪽 번호 기록) |
| 2 | W4 세부(`__seen` 출력·복구 시간·`worker-recover-source` 진단 줄) | 미수신 |
| 3 | W5 항목 a–g 별 세부 | 미수신 |
| 4 | W6 대시보드 업로드 | 하지 않음(선택 항목, 개발자 계정 사용 여부 미확인) |
| 5 | 측정 중 전원 연결 상태 | 사용자도 확인하지 못함(준비 시점 배터리 방전 상태로 보였음) |
| 6 | 탭 메모리 입력 단위 | 사용자 확인 없음(K 로 해석) |
| 7 | 작업 관리자 행 이름·3회 입력 방식 | 미수신 |
| 8 | W3 단계별 값·스크린샷 | 미수신 |

### 9.3 후속

- 결정: ~~D4 체크포인트, 쪽 판정 1.0 s 대체안, 메모리 목표 정의, 과탐 기준, I3~~ 사용자 결정 2026-10-21 로 확정·반영(`docs/m5-followup.md`, `m5-followup` 브랜치). 남은 결정: I1·I2, 기준점 이후 재적용 2 s 초과 대응(`docs/m5-followup.md` 9절 #4), shared-types `ReplayOptions` 승인(F1). **2026-10-22 추가**: 성능 합격 기준(중앙값·p95, 9.2), 탭 메모리 대응(현재 쪽 core 캐시, `docs/m5-followup.md` 5.2 제안), nasa 편집 반응 대응(`docs/m5-perf.md` 7절 #8 제안).
- 수정: ~~재적용 실패 2건(R4)~~ 수정(`docs/m5-followup.md` 2절). ~~kogl-mods-cpi-202609 WASM 메모리~~ 수정(2026-10-22, `docs/m5-followup.md` 5.1). 남은 것: M4 진단값 노출, L1–L5·L7, OOB 200회 재실행, kogl-mods-cpi-202609 탭 메모리(`docs/m5-followup.md` 5.2).
- 사용자: Windows 메모리 재측정(W2 수정 뒤 새 `dist`, kogl-mods-cpi-202609·kogl-nabo-finstmt2025·nist-sp800-53r5, 탭 값은 작업 관리자 K 그대로), 100 MB 이상 실제 문서 확정, 대시보드 업로드, 이름·상표 확인, `v1.0.0` 태그 push.
