# M5 성능·벤치마크 (S2)

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-21 |
| 범위 | `docs/m5-contract.md` 4.1·D1 (벤치 하네스, 렌더 캐시, 쪽 판정 시간, 메모리 왕복, MuPDF OOB 감시) |
| 브랜치 | `m5-perf` (기준 `m5` 6e4f3b2) |
| 판정 기준 | Windows 기준 PC 의 사용자 실행 결과. 서버 결과는 회귀 감시용(D1) |

## 1. 하네스 사용법

### 1.1 구성

| 구성 | 위치 | 내용 |
| --- | --- | --- |
| 측정 페이지 | `apps/extension/bench.html`, `src/viewer/bench*.ts` | 확장 안 진단 페이지. 문서를 골라 지표를 돌리고 결과 JSON 을 내보낸다. `viewer.html` 진단 영역의 "M5 벤치마크 페이지" 링크로도 연다 |
| 지표 이벤트 | `src/viewer/bench-marks.ts` | D1 표의 `m5:*` 이름 그대로 `performance.mark` 를 남긴다. 편집 반응 표식은 `packages/viewer-ui/src/edit-session.ts` 가 남긴다 |
| 통계·목표 | `src/viewer/bench-stats.ts` | p50·p95(nearest-rank)·목표 판정·직전 대비 +20% 회귀 표시 |
| 서버 실행 | `apps/extension/e2e/bench-*.spec.ts`, `bench-harness.ts` | Playwright 번들 Chromium 에 같은 페이지를 로드해 실행. 렌더러 VmRSS 를 읽는다 |
| 문서 세트 | `fixtures/bench/manifest.json`, `prepare.mjs`, `synth.mjs` | 코퍼스 문서 + 합성 문서. 100 MB 이상 실제 문서 자리(`large-real-*`)는 `url: null` 로 비워 둠 |
| Node 도구 | `packages/core/bench/*.mjs` | 판정 구성 분해, OOB 퍼징 |

### 1.2 지표와 측정 방식

| 지표 | 시작 → 끝 이벤트 | 측정 방식 |
| --- | --- | --- |
| 열기 | `m5:open:bytes-received` → `m5:open:first-page-shown` | 새 Worker(모듈·WASM 적재 완료) → `open` → 컨트롤러 시작 → 첫 캔버스 그림. 5회 반복 |
| 쪽 넘김 | `m5:nav:request` → `m5:nav:page-shown` | 순차 20회(쪽마다 300 ms 쉼: 미리 렌더 작동)와 고정 시드 임의 이동 10회. 목표는 둘을 합친 p95 |
| 쪽 판정 | `m5:judge:page-enter` → `m5:judge:editability-ready` | 새 세션에서 쪽 6곳 첫 진입(캐시 비어 있음)과, 다른 쪽에 갔다 돌아온 재진입(`judgeReuse`). 쪽이 보인 시점부터 편집 가능 판정 완료까지 |
| 편집 반응 | `m5:edit:input` → `m5:edit:preview-composited` | 첫 편집 가능 문단에서 30자 입력(60 ms 간격). 뷰어 자체 표식 |
| 패스 끌기 | `m5:path:pointermove` → `m5:path:frame-painted` | 가장 큰 편집 가능 패스를 골라 `PathGesture.update` 40단계, 단계마다 두 번째 `requestAnimationFrame`. M4 `path-latency` 와 같은 정의. 서버 미리보기 왕복은 `serverUpdateMs` 로 따로 기록 |
| 전체 저장 | `m5:save:start` → `m5:save:bytes-ready` | `planSave` + `save({changes: []})`. 편집 전(clean)과 편집 1회 뒤(edited) 각 3회 |
| 메모리 | `m5:mem:baseline` → `m5:mem:end` | 첫 저장 직후를 기준점으로 50쪽 넘김 왕복(98회 이동) → 편집 20회 → 저장 2회. 끝 측정 시점(사용자 결정 2026-10-21): WASM 은 MuPDF 캐시를 비운(`emptyStore`) 뒤 사용 중 힙(벤치 전용 RPC `benchProbeHeap`, 기준점도 같은 정의), 탭은 끝 30 s 대기 뒤 값(서버 VmRSS 또는 수동 입력). 이전 정의 값(선형 메모리 `wasmHeapBytes` 증가, 대기 전 탭 증가)도 결과에 남긴다 |

500쪽 초과 문서의 열기·저장은 목표 판정에서 뺀다(D1: 500쪽 이하 문서 목표).

### 1.3 Windows 수동 실행 절차

pnpm·Node 설치가 필요 없다. 준비물은 압축해제한 `dist` 폴더와 측정할 PDF 파일뿐이다.

1. Chrome 정식 최신에서 `chrome://extensions` → 개발자 모드 켬 → "압축해제된 확장 프로그램을 로드합니다" → `dist` 폴더 선택.
2. 확장 ID 를 확인해 주소창에 `chrome-extension://<확장 ID>/bench.html` 을 연다(`viewer.html` 하단 "M5 벤치마크 페이지" 링크도 같다).
3. 측정 조건을 맞춘다: 다른 탭·창을 닫고, 전원 연결, 절전 끔, 다른 확장 끔(가능하면). 측정 중에는 PC 를 건드리지 않는다.
4. "문서 선택" 에서 `fixtures/bench/manifest.json` 의 문서를 고른다(여러 개 가능). 100 MB 이상 문서는 열기·쪽 넘김·저장만 체크한다.
5. 지표를 모두 체크하고 "실행". 상태 줄에 진행이 표시된다. 서버에서 문서 하나에 약 40초가 걸린다(문서 크기·PC 에 따라 다름).
6. 메모리 시나리오는 세 번 멈춘다(기준점·종료 직후·종료 30초 뒤). 종료 직후 값을 넣으면 페이지가 30초를 센 뒤 다시 멈춘다(그동안 PC 를 건드리지 않는다). 멈추면 `Shift+Esc` 로 Chrome 작업 관리자를 열어 이 확장의 뷰어 프레임 행(`확장 프로그램: PDF Editor` 또는 `하위 프레임: chrome-extension://…`)의 "메모리 사용 공간"을 MiB 로 읽어 입력칸에 넣고 "입력했음, 계속" 을 누른다. GB 표시는 ×1024. 판정은 30초 뒤 값이다.
7. 끝나면 "결과 JSON 내보내기" 로 받은 파일(`m5-bench-<시각>.json`)을 회신한다. 요약 표(p95)가 화면에도 나온다.
8. PC 사양(CPU·RAM·Windows·Chrome 버전)은 JSON `env` 에 자동으로 들어가지만, 작업 관리자 행 이름과 이상 현상(멈춤·탭 크래시)은 따로 알려 준다.

### 1.4 서버 실행

```bash
pnpm exec turbo run build --filter=@pdf-editor/extension
# 스모크(기본 e2e 에 포함)와 메모리 왕복 시험(합성 60쪽)
pnpm --filter @pdf-editor/extension exec playwright test e2e/bench-smoke.spec.ts e2e/bench-memory.spec.ts
# 정식 실행(옵트인): 문서마다 새 브라우저. 결과 out/m5-bench/<label>.json
BENCH_RUN=1 BENCH_CORPUS_DIR=/mnt/nas4/kjune/pdf-editor/fixtures/corpus BENCH_TIER=core,judge-stress \
  pnpm --filter @pdf-editor/extension exec playwright test e2e/bench-run.spec.ts
```

환경 변수: `BENCH_TIER`(core·judge-stress·synthetic·large-real), `BENCH_DOCS`, `BENCH_SCENARIOS`, `BENCH_LABEL`, `BENCH_BASELINE`(직전 기록, 기본 `fixtures/bench/baseline-server.json`; +20% 초과 지표를 `regressions` 에 표시).

```bash
# 쪽 판정 구성 분해(Worker 밖, 새 세션 반복)
node packages/core/bench/judge-breakdown.mjs --doc <코퍼스>/kogl-mods-cpi-202609.pdf --pages 3,12,21 --reps 5
# MuPDF OOB 감시(프로세스 1회 = 1 run)
node packages/core/bench/oob-fuzz.mjs --runs 200 --jobs 4 --corpus-dir <코퍼스>
```

## 2. 렌더 캐시 LRU

| 항목 | 내용 |
| --- | --- |
| 구현 | `packages/viewer-ui/src/render-cache.ts`(`RenderCache`), `controller.ts` 의 `loadView`·`invalidatePages`·`handleWorkerRecovered` |
| 키·상한 | (쪽, 렌더 배율). 8쪽과 64 MiB 중 작은 쪽. 비트맵 하나가 64 MiB 를 넘거나 부분 영역 렌더(`clip`)면 담지 않는다 |
| 무효화 | `invalidatePages(pages)`(편집 확정·되돌리기·다시 실행·복구)가 해당 쪽을 모든 배율에서 버린다. Worker 복구 시 전체 비움. 무효화 때마다 `epoch` 를 올려, 그 전에 시작한 렌더가 뒤늦게 도착해도 담지 않는다 |
| 미리 렌더 | 현재 쪽 처리(렌더·추출·판정)가 끝난 뒤 유휴 시점(`requestIdleCallback`, 없으면 `setTimeout 0`)에 다음 쪽 1쪽을 같은 배율로 렌더. 편집 중·로딩 중·쪽이 바뀌었으면 건너뜀. 실패는 무시 |
| 시험 | `packages/viewer-ui/test/render-cache.test.ts` 7건(8쪽 상한, 바이트 상한, 큰 비트맵·부분 영역 제외, 무효화·epoch, 재방문 시 렌더 미호출, 미리 렌더 뒤 이동 시 렌더 미호출, 쪽 무효화) |
| 효과(서버) | 순차 쪽 넘김 p95 2–24 ms(미리 렌더 적중), 임의 이동 p95 19–113 ms. 둘 다 목표 300 ms 의 1/2.5 이하 |
| 탭 메모리 영향 | 캐시 상한 8쪽·64 MiB 를 `maxPages 1`·미리 렌더 끔으로 바꿔 비교(3문서 ×2회): 탭 메모리 증가에 차이 없음(±30 MiB, 측정 변동 안). 3.3 참조 |

## 3. 서버 기준 결과

### 3.1 측정 조건

| 항목 | 값 |
| --- | --- |
| 환경 | 서버(Linux x86_64, 32 스레드, 125 GiB), Playwright 번들 Chromium 156 headless, 뷰포트 1280×1000, dpr 1 |
| 부하 | 다른 세션과 같은 서버를 공유한다(실행 중 load average 5–8). 절대값보다 비율과 반복 간 일관성을 본다 |
| 실행 | 문서마다 새 브라우저(새 렌더러). `m5-perf` 최종 커밋의 `dist` |
| 원자료 | `out/m5-bench/server-core-final.json`, `server-synthetic.json`(저장소 밖, git 제외). p95 요약은 `fixtures/bench/baseline-server.json` |
| 표본 수 | 열기 5, 쪽 넘김 30(순차 20+이동 10), 판정 첫 진입 6·재진입 6, 편집 30, 패스 40, 저장 3. 표본이 20 미만이면 p95 = 최댓값이다 |

### 3.2 지표별 p95 (ms)

| 문서 | 쪽 | 열기 | 쪽 넘김 | 판정 첫 진입 | 판정 재진입 | 편집 | 패스 | 저장(편집 전) | 저장(편집 뒤) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nist-sp800-53r5 | 492 | 64 | 23 | 140 | 68 | 10 | 20 | 384 | 233 |
| nasa-se-handbook-sp2016-6105 | 297 | 261 | 53 | 198 | 76 | 5 | 24 | 307 | 287 |
| kogl-nabo-finstmt2025 | 179 | 106 | 18 | 189 | 44 | 14 | 31 | 43 | 90 |
| zen-beamer-7535020 | 81 | 44 | 21 | 89 | 13 | 6 | 14 | 54 | 49 |
| arxiv-2609.09268 | 16 | 71 | 24 | 166 | 94 | 8 | 33 | 32 | 38 |
| kogl-mods-cpi-202609 (최대 패스 쪽 포함) | 26 | 68 | 81 | **993** | 306 | 6 | 16 | 22 | 38 |
| synthetic-image-900 (708 MB) | 900 | 55 | 19 | 9 | 11 | - | - | 900 | 555 |
| synthetic-objects-2000 (객체 524k) | 2000 | 195 | 6 | 21 | 10 | - | - | 73 | 1,935 |
| 목표(D1) | | 1,500(≤500쪽) | 300 | 1,000 | 200 | 100 | 150 | 3,000(≤500쪽) | 3,000(≤500쪽) |

- 합성 2건은 편집·패스 지표를 돌리지 않아 해당 열이 비어 있다(메모리 시나리오의 편집 20회는 두 문서 모두 수행). 합성 900쪽(708 MB)은 열기·렌더·저장이 Chrome 전용 Worker 에서 동작했다(저장 직후 WASM 힙 1,683 MiB, 탭 크래시 없음). 계약 4.2 의 대용량 Chrome Worker 검증은 S1 몫이며, 이 결과는 참고 자료다.
- `kogl-mods-cpi-202609` 의 판정 첫 진입 993 ms 는 6쪽 표본 중 최댓값(= p95)이며 최대 패스 쪽(4쪽)이 그 값이다. 나머지 5쪽은 68–603 ms(603 ms 는 두 번째로 진입한 쪽). 5절 판정 시간 분해 참조.
- 판정 재진입 목표 200 ms 도 같은 쪽에서 306 ms 로 넘는다(나머지 쪽은 모두 이하). 재진입은 Worker 의 추출·원본 연결·레이아웃 캐시를 재사용한 뒤에도 편집 판정 본체가 다시 돈다.
- 편집 반응 표본은 입력 30자의 합성 시간(`pe-edit-latency`)이다. 패스 끌기는 M4 정의(포인터 이동 → 두 번째 rAF)이며 서버 미리보기 왕복은 2–113 ms(`serverUpdateMs`).
- 열기 p95 최대는 `nasa-se-handbook` 261 ms 로 목표 1,500 ms 의 17%.
- 회귀 표시: 이 기록이 첫 기준이라 직전 기록이 없다(`fixtures/bench/baseline-server.json` 으로 저장).

### 3.3 메모리 왕복 (계약 1.1: 첫 저장 직후 → 50쪽 넘김 왕복 98회 → 편집 20회 → 저장 2회)

끝 측정 시점은 사용자 결정 2026-10-21(계약 D1·4.1)을 따른다: WASM 은 MuPDF 캐시를 비운(`emptyStore`) 뒤 사용 중 힙, 탭은 끝 30 s 대기 뒤. 기준점도 같은 정의(첫 저장 직후 → `emptyStore` 뒤 사용 중 힙)로 잰다. 2026-10-21 `m5-followup` 재측정(`BENCH_TIER=core,judge-stress,synthetic BENCH_SCENARIOS=mem BENCH_LABEL=followup-mem`, 원자료 `out/m5-bench/followup-mem.json`, git 제외).

| 문서 | WASM 사용 중 힙 MiB(기준점 → 끝, `emptyStore` 뒤) | **WASM 증가 MiB (≤64, 판정)** | 비우기 전: 선형 메모리 MiB(기준점 → 끝) / 증가 | 탭 MiB(기준점 → 끝 직후 → 30 s 뒤) | **탭 증가 MiB (≤150, 판정)** | 대기 전 탭 증가 MiB | 강제 GC 뒤 탭 증가 MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| nist-sp800-53r5 | 12.6 → 40.2 | 27.6 | 27.6 → 69.0 / 41.4 | 330 → 823 → 426 | 96.1 | 493.1 | 92.3 |
| nasa-se-handbook-sp2016-6105 | 11.3 → 42.4 | 31.1 | 45.8 → 95.0 / 49.2 | 303 → 997 → 424 | 121.6 | 693.9 | 121.3 |
| kogl-nabo-finstmt2025 | 8.6 → 23.3 | 14.8 | 22.0 → 54.9 / 32.9 | 313 → 910 → 411 | 97.9 | 597.5 | 96.6 |
| zen-beamer-7535020 | 7.4 → 18.4 | 11.0 | 30.8 → 99.2 / 68.4 | 305 → 687 → 401 | 95.5 | 382.1 | 95.0 |
| arxiv-2609.09268 (16쪽) | 8.7 → 22.0 | 13.3 | 22.0 → 38.1 / 16.1 | 330 → 856 → 428 | 97.5 | 525.8 | 94.5 |
| kogl-mods-cpi-202609 (26쪽) | 8.4 → 113.6 | **105.2** | 22.0 → 156.6 / 134.6 | 301 → 2752 → 978 | **676.9** | 2451.1 | 671.8 |
| synthetic-image-900 | 7.9 → 12.4 | 4.6 | 1916.5 → 1916.5 / 0 | 4069 → 4151 → 3435 | -634.5 | 81.9 | -634.7 |
| synthetic-objects-2000 | 85.0 → 142.9 | 57.9 | 165.1 → 342.6 / 177.5 | 518 → 819 → 689 | **170.6** | 301.4 | 170.3 |

- 판정(서버, 회귀 감시용): WASM 증가 ≤ 64 MiB 는 7/8 문서 충족(kogl-mods-cpi 105.2 MiB 미충족). 탭 증가 ≤ 150 MiB 는 6/8 충족(kogl-mods-cpi 676.9, synthetic-objects-2000 170.6 미충족). 같은 실행의 이전 정의 값(선형 메모리 증가·대기 전 탭)으로는 WASM 5/8·탭 1/8 이다.
- 사용 중 힙은 벤치 전용 RPC `benchProbeHeap`(`@pdf-editor/core/bench`, dev 빌드만)으로 잰다: 선형 메모리 확장을 막고 `_wasm_malloc` 으로 빈 공간을 16 MiB → 1 MiB → 64 KiB 조각으로 받아 본 뒤 돌려주고, 선형 메모리 − 받은 합을 사용 중으로 센다. 선형 메모리는 줄지 않으므로 `emptyStore` 뒤 값은 이 방식이어야 의미가 있다. MuPDF malloc 은 실패 시 자원 캐시를 비우므로 측정 자체가 캐시 비운 상태다. 64 KiB 보다 작은 빈 조각은 사용 중으로 센다.
- 30 s 대기 동안 탭 메모리가 크게 준다(예: nasa 997 → 424 MiB). 대기 뒤 값과 강제 GC 뒤 값의 차는 5 MiB 이내였다: 30 s 안에 유휴 GC 가 수거 가능한 쓰레기를 대부분 수거한다.
- 탭 기준점이 이전 기록(420–999 MiB)보다 낮다(301–330 MiB). 원인은 확인하지 않았다. 판정은 같은 실행 안의 증가분이다.
- kogl-mods-cpi-202609 조사는 `docs/m5-followup.md` 5절.
- 시험으로 고정한 값: `apps/extension/e2e/bench-memory.spec.ts`(기본 e2e). 합성 60쪽 문서에서 98회 이동·편집 20회·저장 2회 뒤 판정값 WASM 증가 ≤ 64 MiB·탭 증가(30 s 뒤) ≤ 150 MiB, 대기 전 탭 증가 ≤ 250 MiB. 측정값(2026-10-21): WASM 4.5 MiB(선형 0), 탭 24.5 MiB(대기 전 128.9). 실제 코퍼스 `nist-sp800-53r5` 시험은 `BENCH_CORPUS_DIR` 가 있을 때만 돈다(WASM 판정값만 단언).

<details><summary>이전 정의 기록(M5 S2, 2026-10-21, 선형 메모리·종료 직후 탭)</summary>

| 문서 | WASM 힙 기준점 MiB | 종료 MiB | 증가 MiB (≤64) | 탭 증가 MiB (≤150) | 강제 GC 뒤 증가 MiB | 구간별 탭 MiB (기준 → 넘김 → 편집 → 종료 → GC) |
| --- | --- | --- | --- | --- | --- | --- |
| nist-sp800-53r5 | 26.4 | 65.9 | 39.5 | 170 | -78 | 721 → 844 → 880 → 911 → 663 |
| nasa-se-handbook-sp2016-6105 | 45.8 | 114.0 | **68.2** | 244 | 63 | 555 → 788 → 781 → 800 → 619 |
| kogl-nabo-finstmt2025 | 22.0 | 54.9 | 32.9 | 271 | 133 | 667 → 909 → 927 → 938 → 799 |
| zen-beamer-7535020 | 26.4 | 99.8 | **73.3** | 251 | 114 | 420 → 584 → 620 → 672 → 534 |
| arxiv-2609.09268 (16쪽) | 22.0 | 38.1 | 16.1 | 220 | -105 | 771 → 921 → 986 → 992 → 666 |
| kogl-mods-cpi-202609 (26쪽) | 22.0 | 164.2 | **142.2** | **1,331** | **1,312** | 999 → 1986 → 2626 → 2330 → 2311 |
| synthetic-image-900 | 1,682.7 | 1,682.7 | 0 | 34 | -665 | 3923 → 3310 → 3296 → 3956 → 3257 |
| synthetic-objects-2000 | 124.7 | 215.5 | **90.8** | 234 | 111 | 529 → 613 → 661 → 763 → 640 |

- 탭 메모리 = 이 확장 렌더러(`--extension-process`)의 `/proc/<pid>/status` VmRSS. "강제 GC 뒤" 는 종료 값을 잰 다음 CDP `HeapProfiler.collectGarbage`(페이지+Worker)를 돌리고 1.5 s 뒤 다시 잰 값에서 기준점을 뺀 것이다. 기준점 자체에 시작 시 쓰레기가 섞여 있어 음수가 나올 수 있다.
- WASM 힙 증가는 `save` 결과의 `wasmHeapBytes`(선형 메모리 크기, 줄지 않음)의 종료−기준점이다.
- 증가의 성격(누수 아님):
  - 쪽 넘김 50쪽을 같은 방식으로 반복하면 WASM 힙은 첫 왕복 뒤 더 늘지 않는다(Node 직접 시험, 4회 반복: nasa +43.9 MiB, beamer +26.1 MiB 에서 정지). MuPDF `shrinkStore(25)` 는 효과가 없었다(beamer 오히려 +38.5).
  - 나머지 증가는 편집 20회와 저장 2회(저널·전체 저장 작업 메모리)이다.
  - 탭 메모리는 수거 가능한 쓰레기가 대부분이다. nasa: 종료 800 → GC 후 619(기준 555). Node 에서 `kogl-mods-cpi` 26쪽 2회 순회 시 JS 힙이 1.7 GB 까지 오르고 `gc()` 뒤 182 MiB 로 돌아왔다(RSS 는 2 GB 로 남음). 즉 V8/할당기가 돌려주지 않는 몫이다.
  - 렌더 캐시는 원인이 아니다: 캐시 8쪽·64 MiB ↔ 1쪽·미리 렌더 끔 비교(nasa·kogl-nabo·beamer 각 2회): 탭 증가 차이 ±30 MiB 이내(변동 범위).
- 서버 결과는 D1 목표 중 WASM 증가 ≤ 64 MiB 를 4개 문서에서, 탭 증가 ≤ 150 MiB 를 7개 문서에서 넘는다. D1 에서 서버는 판정이 아니라 회귀 감시이며, 탭 메모리는 Windows 작업 관리자 값으로 다시 판정해야 한다(7절).
- 시험으로 고정한 값: `apps/extension/e2e/bench-memory.spec.ts`(기본 e2e). 합성 60쪽 문서에서 98회 이동·편집 20회·저장 2회 뒤 WASM 증가 ≤ 64 MiB, 탭 증가 ≤ 150 MiB. 실제 코퍼스 `nist-sp800-53r5` 시험은 `BENCH_CORPUS_DIR` 가 있을 때만 돈다(WASM 증가 ≤ 64 MiB 만 단언, 탭 증가는 GC 뒤 값 기준으로 단언하지 않고 기록).

</details>

### 3.4 발견: 브라우저 번들에서 `wasmHeapBytes` 가 null

`packages/core/src/session.ts` 가 `mupdf` 를 먼저 import 하고 `wasm-module.js` 를 나중에 import 해, 번들(rolldown) 안에서 `mupdf` 가 먼저 평가되었다. 그 결과 `$libmupdf_wasm_Module` 이 `mupdf` 초기화 뒤에 만들어져 `HEAPU8` 가 연결되지 않고 `SaveResult.wasmHeapBytes` 가 항상 null 이었다(Node 시험은 core 진입점이 먼저 import 하므로 가려졌다). `session.ts` 첫 줄에 `import './wasm-module.js'` 를 두어 고쳤다. **S1 의 저장 힙 모델은 브라우저에서 이 값을 쓰므로 머지 시 이 한 줄이 필요하다.**

## 4. MuPDF WASM OOB 간헐 감시

| 항목 | 내용 |
| --- | --- |
| 스크립트 | `packages/core/bench/oob-fuzz.mjs` |
| 1 run | 독립 Node 프로세스 1개(`--expose-gc`). 코퍼스 6문서(arxiv-2609.09268, zen-ko-moon-21973474, kogl-mods-cpi-202609, nist-ai-100-1, nasa-eo-2024-janfeb, zen-beamer-10545284)를 열고 문서당 쪽 10개를 시드로 골라 렌더·추출(세그먼트 유무)·SourceMap·원본 연결·레이아웃·편집 판정을 무작위 순서로 호출. 단계 사이 30% 확률로 GC 강제. 문서마다 전체 저장 뒤 저장 결과를 다시 열어 0쪽 렌더 |
| 판정 | 예외 메시지(또는 비정상 종료 stderr)가 `memory access out of bounds`·`unreachable`·`RuntimeError`·`table index is out of bounds` 에 맞으면 OOB 로 센다 |
| 실행 | 2026-10-21, 200회, 병렬 4, Node v22.18.0, mupdf 1.28.1, 소요 14분 |
| 결과 | **200회 중 성공 200, 실패 0, OOB 0** |
| 원자료 | `out/m5-oob/oob-200.json`(git 제외, 실행별 시드·단계 수) |
| 한계 | 0회는 "이 조건에서 재현되지 않음" 이다. `docs/m1-decisions.md` 의 최초 발생은 정책 퍼징 테스트(합성 셰이딩 + GC)였고, 이 스크립트는 코퍼스 쪽 표본 위주라 합성 셰이딩 경로는 덜 다룬다. 주기 실행(릴리스 전)으로 쓴다 |

재실행: `node packages/core/bench/oob-fuzz.mjs --runs 200 --jobs 4 --corpus-dir <코퍼스>`. OOB 가 있으면 종료 코드 1, `failures` 에 문서·쪽·단계·스택·직전 12단계가 남는다.

## 5. 쪽 판정 시간 분해

첫 진입 판정 = Worker 안에서 `getPageEditability` 가 하는 전체 일이다. 아래는 Worker 밖에서 새 세션을 반복해(5–7회 중앙값) 단계별로 부른 값이다(`packages/core/bench/judge-breakdown.mjs`, 구조화 복제 없음). 각 단계는 앞 단계 결과를 캐시로 재사용하므로 "그 단계가 새로 더한 시간"이며, 합은 콜드 전체와 같다.

| 쪽 | 추출 | SourceMap | 원본 연결 | 레이아웃 | 판정(나머지) | 합 | 콜드 전체(중앙값/최소) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kogl-mods-cpi 4쪽(최대 패스 쪽) | 244 | 332 | 87 | 191 | 135 | 989 | **1,049 / 922** |
| kogl-mods-cpi 13쪽 | 17 | 29 | 3 | 123 | 10 | 182 | 181 / 170 |
| kogl-mods-cpi 22쪽 | 25 | 37 | 3 | 47 | 10 | 122 | 127 / 120 |
| nist-sp800-53r5 130쪽 | 20 | 10 | 2 | 85 | 11 | 128 | 127 / 122 |
| nist-sp800-53r5 372쪽 | 18 | 9 | 1 | 71 | 9 | 108 | 111 / 108 |
| arxiv-2609.09268 11쪽 | 30 | 17 | 3 | 137 | 14 | 201 | 216 / 175 |
| arxiv-2609.09268 15쪽 | 15 | 9 | 1 | 72 | 12 | 109 | 108 / 105 |

- 최대 패스 쪽을 뺀 모든 쪽은 콜드 전체 250 ms 이하로 목표 1.0 s 의 1/4 이하다.
- 최대 패스 쪽의 구성: SourceMap 33%, 추출 25%, 레이아웃 19%, 판정 나머지 13%, 원본 연결 8%.
- 이전(M4 통합 기록) 1.75 s 에 대해: 텍스트 층용 추출(경로 세그먼트 없음)과 편집 판정의 추출(세그먼트 포함)이 같은 쪽 콘텐츠를 두 번 해석했다. 변경 전 같은 쪽 콜드 전체는 같은 방법으로 1.6–2.1 s(3회, 서버 부하 6–7 상태), 변경 후 0.92–1.15 s(7회). 해석 1회 분 250–350 ms 가 줄었다.
- 변경: `PdfSession.extractPage` 가 한 번의 해석으로 세그먼트 포함 모델을 만들어 캐시하고 세그먼트 없는 모델은 거기서 파생한다(`packages/core/src/session.ts`, 시험 1건 추가). 텍스트 층용 첫 추출은 세그먼트를 모으는 만큼 약간 늦다(최대 패스 쪽 약 +90 ms, 나머지 쪽은 몇 ms).
- 브라우저 측정 페이지의 단계 분해(`judge.breakdown`)는 각 단계 결과를 메인 스레드로 돌려주는 구조화 복제가 들어 있어 위 값보다 크다(최대 패스 쪽 SourceMap 1,509 ms 가 그 예). 구성 판단에는 위 Node 표를 쓴다.
- 대체안(패스 판정 지연) 판단: 서버 기준 최대 패스 쪽 콜드 전체 중앙값이 1.05 s 로 목표 1.0 s 와 거의 같고 나머지 쪽은 크게 이하다. 패스 판정만 미뤄도 줄어드는 몫은 추출 세그먼트(이미 공유됨)·판정 나머지 일부(약 100 ms)뿐이라 이 쪽을 1.0 s 아래로 내리지 못한다. 구현하려면 `PageEditability` 에 패스 판정 보류 표시가 필요해 shared-types 변경(메인 세션 권한)이 선행된다. Windows 결과가 나오기 전에는 적용하지 않고 7절에 결정 사항으로 남긴다.

## 6. 변경 파일

| 구분 | 파일 |
| --- | --- |
| 렌더 캐시 | `packages/viewer-ui/src/render-cache.ts`(새), `controller.ts`, `index.ts`, `test/render-cache.test.ts`(새) |
| 판정 시간 | `packages/core/src/session.ts`(`extractPage`, 첫 줄 import), `test/session.test.ts`, `packages/core/bench/judge-breakdown.mjs`(새) |
| 편집 반응 표식 | `packages/viewer-ui/src/edit-session.ts`(`m5:edit:*` 표식 2줄) |
| 하네스 | `apps/extension/bench.html`·`vite.config.ts`(입력 1줄)·`viewer.html`(링크 1줄), `src/viewer/bench*.ts·css`, `test/bench-stats.test.ts`, `e2e/bench-*.ts` |
| 문서 세트 | `fixtures/bench/manifest.json`·`prepare.mjs`·`synth.mjs`·`baseline-server.json` |
| OOB | `packages/core/bench/oob-fuzz.mjs` |

## 7. 남은 일·결정 요청

| # | 항목 | 담당 | 내용 |
| --- | --- | --- | --- |
| 1 | Windows 기준 PC 측정 | 사용자 | 1.3 절 절차로 core 5건 + `kogl-mods-cpi-202609` 실행, JSON 회신. 100 MB 이상 문서는 열기·넘김·저장만 |
| 2 | 100 MB 이상 실제 문서 | 메인 세션 | `fixtures/bench/manifest.json` 의 `large-real-image`·`large-real-objects` 는 `url: null` 자리만 있다. 확정 시 `prepare.mjs --tier large-real` 로 바로 돈다 |
| 3 | 쪽 판정 1.0 s(사용자 결정 2026-10-21: Windows 중앙값이 1.0 s·재진입 200 ms 를 넘으면 대체안 구현 사전 승인) | Windows 측정 대기 | 서버 최대 패스 쪽 콜드 1.05 s(0.92–1.15). Windows 에서 초과하면 대체안(패스 판정 지연)이 필요하고, `PageEditability` 에 보류 표시(또는 문단만 판정하는 요청 인자)를 더하는 shared-types 변경이 선행된다. 판정 재진입 200 ms 도 같은 쪽이 306 ms |
| 4 | 메모리 목표의 정의(사용자 결정 2026-10-21: 목표값 유지, 끝 = `emptyStore` 뒤·30 s 뒤, 3.3 재측정) | 결정됨 | 서버 결과가 WASM 증가 64 MiB 를 4/8 문서, 탭 증가 150 MiB 를 7/8 문서에서 넘는다. 원인은 캐시(누수 아님)·수거 가능한 쓰레기다. Windows 작업 관리자 값이 나오면 목표 값 또는 측정 시점(GC 뒤 등)을 D1 에서 다시 정한다 |
| 5 | S1 머지 | 메인 세션 | `session.ts` 첫 줄 `import './wasm-module.js'` 가 S1 의 저장 힙 모델에 필요(3.4). S1 도 `session.ts` 를 만지므로 충돌 시 이 줄을 유지 |
| 6 | S3 머지 | S3 | `vite.config.ts` 의 `bench` 입력 1줄과 `viewer.html` 의 링크 1줄은 S3 의 릴리스 빌드·진단 숨김과 구역이 인접하다. 릴리스 빌드에서는 `bench.html` 을 제외하거나 숨긴다(D6: 벤치 버튼은 릴리스에서 숨김) |
| 7 | OOB 주기 실행 | 사용자/메인 | 릴리스 전 200회 재실행 권고. 합성 셰이딩 경로 추가 여부 |
