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
| 메모리 | `m5:mem:baseline` → `m5:mem:end` | 첫 저장 직후를 기준점으로 50쪽 넘김 왕복(98회 이동) → 편집 20회 → 저장 2회. 추가 WASM 힙은 저장 결과의 `wasmHeapBytes`, 탭 메모리는 서버 VmRSS 또는 수동 입력 |

500쪽 초과 문서의 열기·저장은 목표 판정에서 뺀다(D1: 500쪽 이하 문서 목표).

### 1.3 Windows 수동 실행 절차

pnpm·Node 설치가 필요 없다. 준비물은 압축해제한 `dist` 폴더와 측정할 PDF 파일뿐이다.

1. Chrome 정식 최신에서 `chrome://extensions` → 개발자 모드 켬 → "압축해제된 확장 프로그램을 로드합니다" → `dist` 폴더 선택.
2. 확장 ID 를 확인해 주소창에 `chrome-extension://<확장 ID>/bench.html` 을 연다(`viewer.html` 하단 "M5 벤치마크 페이지" 링크도 같다).
3. 측정 조건을 맞춘다: 다른 탭·창을 닫고, 전원 연결, 절전 끔, 다른 확장 끔(가능하면). 측정 중에는 PC 를 건드리지 않는다.
4. "문서 선택" 에서 `fixtures/bench/manifest.json` 의 문서를 고른다(여러 개 가능). 100 MB 이상 문서는 열기·쪽 넘김·저장만 체크한다.
5. 지표를 모두 체크하고 "실행". 상태 줄에 진행이 표시된다. 문서 하나에 core 5건 기준 약 1–2분이 걸린다.
6. 메모리 시나리오는 두 번 멈춘다(기준점·종료). 멈추면 `Shift+Esc` 로 Chrome 작업 관리자를 열어 이 확장의 뷰어 프레임 행(`확장 프로그램: PDF Editor` 또는 `하위 프레임: chrome-extension://…`)의 "메모리 사용 공간"을 MiB 로 읽어 입력칸에 넣고 "입력했음, 계속" 을 누른다. GB 표시는 ×1024.
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
