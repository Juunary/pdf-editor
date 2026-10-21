# M5 후속: 사용자 결정 반영·재적용 실패 수정·메모리 재측정

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-21 |
| 범위 | 사용자 결정 2026-10-21 5건(`docs/m5-contract.md` 수정 2), `docs/m5-heap.md` 9절 R4 재적용 실패 2건, 메모리 왕복 재측정, 복구 시간 재측정 |
| 브랜치 | `m5-followup`(기준 main b0b4252) |
| 측정 환경 | 서버 `sailab01`, Node v22.18.0, npm `mupdf` 1.28.1, Playwright 번들 Chromium(headless). Windows Chrome 은 미측정 |

## 1. 사용자 결정 5건과 반영 위치

| # | 결정 | 계약·문서 기록 | 코드 반영 |
| --- | --- | --- | --- |
| 1 | D4: 주기 체크포인트 없음. 사용자 저장 성공 결과를 복구 기준점으로, 복구 때 그 뒤 편집만 재적용. 2 s 기준은 기준점 이후 편집에만. 복구 중 진행(n/N) 표시 | `docs/m5-contract.md` 2절 표·D4, `docs/m5-heap.md` 5.4·9절 R3, PLAN.md v2.16 | 3절 |
| 2 | 쪽 판정 1.0 s: Windows 측정 뒤 판정. Windows 중앙값이 1.0 s(재진입 200 ms)를 넘으면 D1 대체안(패스 판정 지연, `m5:judge:paths-ready`)을 별도 결정 없이 구현(조건부 사전 승인) | `docs/m5-contract.md` D1 | 없음(기록만) |
| 3 | 메모리 목표값 유지, 끝 측정 시점 변경: WASM 은 `emptyStore` 뒤, 탭은 30 s 대기 뒤. 비우기 전·대기 전 값도 기록 | `docs/m5-contract.md` 1.1·D1·4.1, `docs/m5-perf.md` 1.2·1.3·3.3 | 4절 |
| 4 | 과탐 기준: 문서 기준(같은 문서·경로의 시나리오 최대 측정 피크) 채택, 시나리오 기준은 기록만 | `docs/m5-contract.md` 4.2, `docs/m5-heap.md` 4.1·8절 C4 | 없음(판정 정의) |
| 5 | I3 크기 알림 통합: 열 때 바이트 기준 안내 1회, 저장 전 판정 warn·over-limit 이면 같은 칸 교체, ok 면 유지, 상한 값은 한 번만 | `docs/m5-contract.md` 4.3 | 6절 |

## 2. R4 재적용 실패: 원인·수정·시험

### 2.1 원인

- 재적용은 로그의 대상 글자 목록(`ParagraphTarget.glyphSeqs`)과 같은 레이아웃 문단을 찾는다(`findParagraphId`).
- 편집 블록을 다시 고친 편집은 대상 글자가 블록 전체다. pdf-ops `analyzeParagraph` 가 블록 문단이면 대상을 블록 글자 전체로 넓힌다(계약 D3, `docs/m3-integration.md` 9절 B1).
- 레이아웃 복원은 커밋한 블록을 문단 하나로 묶으려 하지만(`fixedGroups` 힌트) 일부 쪽에서 블록 끝 글자를 다음 문단에 붙인다. 이때 블록 전체 글자와 같은 레이아웃 문단이 없다.
- 원래 세션은 판정이 내보낸 블록 첫 문단 id 로 편집을 시작하므로 문제가 없고, 재적용만 대상 문단을 찾지 못한다.
- 확인(zen-ko-report-21333257 6쪽, 7번째 편집): 로그 대상 글리프 174개(42–215). 레이아웃 문단 1 은 172개(42–213), 블록 끝 2글자(" #2" 의 214·215)는 다음 문단 2 의 앞에 붙었다. 원래 세션과 재적용 세션의 레이아웃은 같았다(비결정성 아님).
- kogl-mods-cpi-202609 9쪽 89번째(글리프 5개)도 같은 경로였다. 계측 실행에서 재적용 중 이 경로로 찾은 편집: zen 4건(글리프 174·84, 레이아웃 문단 172·82), kogl 2건(글리프 5, 레이아웃 문단 3).

### 2.2 수정

- `packages/core/src/edit-engine.ts` `findParagraphId(ctx, target, targetOf?)`: 정확히 같은 레이아웃 문단이 없고 대상이 편집 블록(`editedBlock` 있음)이면, 로그 글자를 가진 레이아웃 문단을 후보로(첫 글자를 가진 문단 먼저) 계획을 세워 계획 대상의 글자 목록·블록 id 가 로그와 같은 문단을 고른다.
- 흐름 문단(`editedBlock` 없음)·셀 대상은 이전 규칙 그대로다. 계획 계산이 예외를 내는 후보는 건너뛴다.
- 재적용(`#replayOne`)은 후보 계획을 캐시해 고른 문단의 계획을 그대로 쓴다(계획 중복 계산 없음).

### 2.3 시험

| 시험 | 내용 | 결과 |
| --- | --- | --- |
| `packages/core/test/edit-replay-target.test.ts`(합성 축소 사례 5건) | 블록 글자 0–5 중 4·5 가 다음 문단에 붙은 레이아웃: 계획 대상으로 찾음, 확인 함수 없으면 실패, 흐름 문단은 넓히지 않음, 블록 id·글자 불일치 실패, 계획 예외 건너뜀 | 통과 |
| `packages/core/test/replay-corpus.test.ts`(코퍼스 옵트인) | `REPLAY_CORPUS_DIR` 있을 때 zen 6쪽 20건, `REPLAY_CORPUS_LONG=1` 이면 kogl 9쪽 100건. 재적용 성공·쪽 텍스트 = 원래 세션 | zen 통과(2.2 s). kogl 은 재현 명령으로 확인 |
| 재현 명령 `journal-child.mjs … zen-ko-report-21333257.pdf 5 20 distinct` | 수정 전 `재적용 실패(7/20번째)` | 수정 뒤 재적용 성공 0.44 s |
| 재현 명령 `journal-child.mjs … kogl-mods-cpi-202609.pdf 8 100 distinct` | 수정 전 `재적용 실패(89/100번째)` | 수정 뒤 재적용 성공 224.1 s(편집 389.6 s, 서버 부하 있음) |

## 3. D4 복구 기준점·진행 표시 구현

| 구분 | 변경 |
| --- | --- |
| core | `replayEdits(ops, { more })`(`packages/core/src/edit-engine.ts`): `more: true` 면 적용 뒤 저널을 켜지 않고 다음 호출을 이어 받는다. Info 기록·저널 켜기·revision 증가는 마지막 호출에서 한 번. 이어 받는 중 편집 시작은 `EditStateError`. 실패 메시지는 누적 순번(`재적용 실패(k/n번째, …)`) |
| shared-types | `ReplayOptions { more?: boolean }`, `PdfWorkerApi.replayEdits(ops, options?)`(선택 인자, 기존 호출 그대로) |
| 복구 계층 | `apps/extension/src/viewer/recovery.ts` `ResilientPdf`: `save` 결과 바이트를 기준점 후보로 복사해 두고 `confirmSaved()`(사용자 저장 성공) 때 기준점으로 올린다. 취소·실패·측정 저장은 `discardPendingSave()`. 복구 때 활성 로그가 기준점 편집 id 로 시작하면 기준점 바이트 + 그 뒤 편집만, 아니면 원본 + 활성 로그 전체. 기준점에서 복구하면 기준점이 그 세션의 원본이 되고, 뷰어 로그가 새 이력으로 바뀌기 전 재복구에서도 기준점 편집을 빼고 적용한다. 다른 문서를 열면 기준점을 버린다 |
| 진행 표시 | 재적용을 한 건씩 보내며 `onProgress(n, N)`. 뷰어(`main.ts`)는 알림 칸 `recovered` 에 "문서를 복구하는 중입니다: 편집 n/N 다시 적용", 상태 줄에 "문서 복구 중: 편집 n/N". 완료 알림에 기준점 여부("마지막 저장 시점에서 편집 N건 다시 적용") |
| 진단 | `worker-recover-source` 로그(`fromSavedBaseline`·기준점 편집 수·재적용 수) |

| 시험 | 확인 내용 | 결과 |
| --- | --- | --- |
| `packages/core/test/replay-baseline.test.ts`(실제 어댑터, 5건) | 저장 → 저장 뒤 편집 2건(새 문단, 저장 전 블록 재편집) → 저장 바이트 + 뒤 편집 재적용 = 원래 세션 = 원본 + 전체 로그. 저장 전 편집 텍스트는 한 번만. 이력은 저장 뒤 편집만·되돌리기 불가. 재적용 뒤 저널 추정 0·`journalAdvice` 권고 없음, 새 편집은 되돌리기 가능·저널 추정 증가·되돌리면 재적용 결과로. 저장 뒤 편집 0건. 나눠 적용 = 한 번에 적용(텍스트·이력·revision·저장 결과), 이어 받는 중 편집 시작 거절·마지막 뒤 재적용 거절 | 통과 |
| `apps/extension/test/recovery.test.ts`(+6건) | 기준점 바이트를 열고 뒤 편집만 한 건씩(`more`), 진행 0/1·1/1, `fromSavedBaseline`. 확정하지 않은 저장은 원본 + 전체. 저장 전 편집을 되돌려 접두가 다르면 원본 + 전체. 다른 문서 열면 기준점 버림. 기준점 복구 직후 재복구 중복 없음. `opsAfterBaseline` | 통과 |
| `apps/extension/e2e/edit-integration.spec.ts` "복구 기준점(D4)" | 편집 → downloads 저장 → 같은 블록 2회 편집 → 마지막 되돌리기의 렌더에서 wasm 트랩 → 알림 "마지막 저장 시점에서 편집 1건", 진행 0/1·1/1 표시, 화면·쪽 텍스트 = 복구 전, 저장 전 편집 텍스트 1회, 진단 `fromSavedBaseline: true, replay: 1` | 통과 |

### 3.1 복구 시간(`docs/m5-heap.md` 5.4)

측정: `node tools/bench/recovery-time.mjs <코퍼스>/arxiv-2609.10511.pdf 2 100 10`(3쪽 콘텐츠 1.2 MB, 서로 다른 문단 100건, 90건째 뒤 저장, 저장 뒤 10건). 재적용은 한 건씩, 끝에 그 쪽 렌더.

| 복구 방식 | 재적용 편집 | 열기 ms | 재적용 s | 쪽 렌더 ms | 합계 s | 쪽 텍스트 = 원래 세션 |
| --- | --- | --- | --- | --- | --- | --- |
| 원본 + 전체 로그(이전 방식) | 100 | 0.6 | 29.7(1회째 30.8) | 70 | 29.8 | 같음 |
| 저장 기준점 + 저장 뒤 편집 | 10 | 1.8 | 3.42(1회째 3.78) | 73 | 3.49 | 같음 |

- 기준점 복구는 재적용 편집 수만큼 줄었다(29.8 → 3.5 s). 저장 뒤 10건은 2 s 기준을 넘는다(1건당 약 0.34–0.38 s). 이 쪽에서 2 s 안에 드는 저장 뒤 편집은 약 5건이다. 결정(기준은 기준점 이후 편집에만 적용)은 바꾸지 않고 결과만 기록한다(9절 #4).

## 4. 메모리 측정 시점 변경과 재측정

### 4.1 구현

| 구분 | 변경 |
| --- | --- |
| core | `packages/core/src/bench-memory.ts` `probeWasmHeap({ emptyStore })`, 하위 경로 `@pdf-editor/core/bench`. `exposePdfWorker(endpoint, options, extra)` 세 번째 인자로 추가 RPC |
| Worker | `apps/extension/src/worker/pdf-worker.ts`: `__BUILD_KIND__ === 'dev'` 일 때만 `benchProbeHeap` 을 더한다. 스토어 빌드는 상수로 접혀 모듈이 번들에 없다 |
| 측정 페이지 | `bench-run.ts` 메모리 왕복: 기준점(첫 저장 직후)과 끝 모두 `emptyStore` 뒤 사용 중 힙으로 WASM 판정, 선형 메모리 증가도 기록. 끝 탭 메모리는 직후·30 s 대기 뒤(판정) 두 번(수동 실행은 입력 3회). 결과 스키마 `m5-bench/2`, 필드 `wasmHeapDeltaMiB`(판정)·`wasmLinearDeltaMiB`·`tabDeltaMiB`(판정)·`tabDeltaBeforeWaitMiB`·`settleMs` |
| 서버 실행 | `e2e/bench-run.spec.ts`·`bench-harness.ts` 는 같은 측정 페이지를 쓰므로 그대로(탭 값은 `end-settled` 표본에서 VmRSS) |
| e2e | `bench-memory.spec.ts`: 판정값 WASM ≤ 64 MiB·탭(30 s 뒤) ≤ 150 MiB, 대기 전 탭 ≤ 250 MiB. `bench-smoke.spec.ts`: 대기 0 으로 새 필드 확인 |
| 릴리스 검사 | `verify-dist --release`: 스토어 번들에 `benchProbeHeap`·`probeWasmHeap` 이 있으면 실패 |

- WASM 선형 메모리는 줄지 않으므로 "`emptyStore` 뒤 값" 을 선형 메모리로 재면 비우기 전과 같다. 그래서 사용 중 힙(선형 − 빈 공간)으로 잰다. 측정 방법·한계는 `docs/m5-perf.md` 3.3.
- 기준점도 같은 정의로 잰다(끝만 바꾸면 기준점 = 선형 메모리 최대치와 비교하게 되어 증가가 음수로 나온다). 기준점 측정이 캐시를 비우므로 기준점 직후 렌더 캐시가 한 번 비워진다.

### 4.2 서버 재측정(8문서, `docs/m5-perf.md` 3.3)

| 문서 | WASM 증가 MiB(판정, ≤64) | 선형 메모리 증가 MiB(비우기 전) | 탭 증가 MiB(30 s 뒤, 판정, ≤150) | 탭 증가 MiB(대기 전) | 목표 |
| --- | --- | --- | --- | --- | --- |
| nist-sp800-53r5 | 27.6 | 41.4 | 96.1 | 493.1 | 충족 |
| nasa-se-handbook-sp2016-6105 | 31.1 | 49.2 | 121.6 | 693.9 | 충족 |
| kogl-nabo-finstmt2025 | 14.8 | 32.9 | 97.9 | 597.5 | 충족 |
| zen-beamer-7535020 | 11.0 | 68.4 | 95.5 | 382.1 | 충족 |
| arxiv-2609.09268 | 13.3 | 16.1 | 97.5 | 525.8 | 충족 |
| kogl-mods-cpi-202609 | **105.2** | 134.6 | **676.9** | 2451.1 | 미충족(둘 다) |
| synthetic-image-900 | 4.6 | 0 | -634.5 | 81.9 | 충족 |
| synthetic-objects-2000 | 57.9 | 177.5 | **170.6** | 301.4 | 미충족(탭) |

- 새 정의: WASM 7/8, 탭 6/8 충족. 같은 실행의 이전 정의 값: WASM 5/8, 탭 1/8.
- 서버 결과는 회귀 감시용이다. 판정은 Windows 기준 PC 결과로 한다(계약 D1).

## 5. kogl-mods-cpi-202609 조사(1차)

별도 조사 항목으로 등록한다(9절 #2). 수정은 하지 않았다(원인이 둘이고 각각 기능 조건이거나 판정 시간과 맞바꾸는 변경).

### 5.1 WASM 증가 105 MiB: 되돌리기 저널

- Node 재현(같은 시나리오: 첫 저장 → 전 쪽 렌더·판정 왕복 → 편집 20회 → 저장 2회, 각 단계 `emptyStore` 뒤 사용 중 힙):

| 단계 | 사용 중 힙 MiB | 저널 추정 MiB |
| --- | --- | --- |
| 첫 저장 직후 | 6.9 | 0 |
| 26쪽 렌더·판정 왕복 뒤 | 9.9 | 0 |
| 편집 5건(1–2쪽) | 18.9 | 0.2 |
| 편집 10건(~6쪽) | 28.3 | 8.6 |
| 편집 15건(9쪽 포함) | 72.3 | 51.2 |
| 편집 20건(9쪽) | 115.2 | 93.8 |
| 저장 2회 뒤 | 114.6 | 93.8 |

- 쪽 넘김·판정·렌더 캐시는 `emptyStore` 뒤에 거의 남지 않는다(+3 MiB). 증가는 편집 20회 중 9쪽(쪽 콘텐츠 8.9 MB) 문단을 처음 고칠 때마다 쪽 콘텐츠가 저널에 남는 몫(1건당 약 8.6 MiB)이다. `docs/m5-heap.md` 5.2 의 저널 증가와 같은 현상이며 누수가 아니다. 저장 뒤 다시 열면 줄어든다(D4 저널 권고 문구).
- 이 문서는 시나리오의 "편집 20회" 가 무거운 쪽에 닿는 구성이라 목표를 넘는다. 목표값·시나리오 정의는 결정대로 두었다.

### 5.2 탭 증가 677 MiB(30 s 뒤): JS 힙

- 서버 단계 표본: 기준 301 → 넘김 뒤·편집 뒤 2,752(직후) → 30 s 뒤 978 → 강제 GC 뒤 973 MiB. 30 s 뒤 값과 GC 뒤 값이 같아 남은 몫은 수거 가능한 쓰레기가 아니다.
- Node 재현(Worker 쪽 core 만, `--expose-gc`): 26쪽 렌더·추출·판정 순회 중 JS 힙 최대 1,069 MiB, 순회 뒤 GC 해도 사용 175.6 MiB·RSS 1,491 MiB. `invalidatePageCache()` 뒤 사용 18.5 MiB(RSS 는 그대로 1,491 MiB).
  - 남는 몫 1: core 쪽 캐시(추출 모델·원본 연결·레이아웃, 최근 16쪽) 약 157 MiB. 경로 세그먼트를 포함한 추출 모델이 크다(9쪽 직렬화 37 MB, 4쪽 패스 32,041개). M5 S2 변경(평문 추출 요청도 세그먼트 포함 모델을 한 번에 만들어 둘 다 캐시)으로 이웃 쪽 레이아웃용 평문 추출도 세그먼트 모델을 남긴다.
  - 남는 몫 2: 순회 중 일시 쓰레기 약 1 GB 로 늘어난 V8 힙을 프로세스가 OS 에 돌려주지 않는 몫(RSS 유지). 쪽 레이아웃 계산 1회에 70–142 MiB 를 할당한다(9·10쪽 근처).
- 수정 후보(미적용):
  - 쪽 캐시 상한을 쪽 수가 아니라 크기(세그먼트 수)로도 두기.
  - 이웃 쪽 레이아웃용 추출은 세그먼트 모델을 캐시하지 않기. 다만 그 쪽에 들어가면 판정 추출을 다시 해 첫 진입 판정 시간이 늘어난다(`docs/m5-perf.md` 5절 해석 1회분 250–350 ms).
  - 레이아웃 계산의 일시 할당 줄이기.
- 렌더 캐시는 원인이 아니다(이전 비교 `docs/m5-perf.md` 2절, 이번 Node 재현에서도 `emptyStore` 뒤 WASM 은 +3 MiB).

## 6. I3 크기 알림 통합

| 구분 | 변경 |
| --- | --- |
| 뷰어 | `apps/extension/src/viewer/main.ts`: 알림 칸 `supported-size` 를 없애고 `size` 하나로. 열 때 `supportedSizeNotice(byteLength)` 를 이 칸에 1회. 열기 직후·저장 전 판정은 `updateSizeNotice`: `sizeLimitNotice` 가 있으면(warn·over-limit) 같은 칸을 교체, ok(null)면 그대로 둔다 |
| 문구 | 바이트 기준 안내는 지원 크기(790 MiB) 한 번, 판정 문구는 예상 피크·한계 한 번. 한 칸이라 두 상한이 함께 나오지 않는다 |
| 단위 시험 | `apps/extension/test/about.test.ts`: 각 문구의 상한 값 출현 1회 |
| e2e | `apps/extension/e2e/extension-save.spec.ts`: 800 MiB 로 보고된 문서 → 칸 하나·790 MiB 안내 → 열기 직후 ok 판정 뒤 유지 → 저장 전 warn 판정 → 같은 칸이 "예상 저장 피크 1600 MiB / 한계 2048 MiB" 로 바뀌고 790 MiB 문구 없음, 2048 MiB 1회. 기존 시험의 알림 id 를 `size` 로 |

## 7. 계약과 다른 점·확인 필요

| # | 내용 | 근거 |
| --- | --- | --- |
| F1 | shared-types `ReplayOptions`·`replayEdits` 선택 인자를 더했다(계약 3절: shared-types 변경은 메인 세션 승인 대상) | D4 진행 표시(n/N)를 하려면 재적용을 나눠 보내야 하고, 저널 켜기·메타 기록을 마지막 호출로 미룰 방법이 필요하다. 선택 인자라 기존 호출은 그대로 |
| F2 | 메모리 "`emptyStore` 뒤 값" 을 선형 메모리가 아닌 사용 중 힙(빈 공간 측정)으로 정의했고, 기준점도 같은 정의로 쟀다 | 선형 메모리는 줄지 않아 비우기 뒤 값이 비우기 전과 같다(4.1). 결정의 목표값·기준점 시점은 그대로 |
| F3 | 기준점 바이트를 뷰어 메모리(Blob)에 한 벌 더 보관한다(원본 Blob 과 별도) | 저장 전 편집까지 되돌리면 원본 + 전체 로그로 돌아가야 해서 원본도 버리지 않는다. 큰 문서는 저장 크기만큼 메인 스레드 Blob 이 는다 |
| F4 | 저장 뒤 편집 10건(1.2 MB 쪽)은 기준점 복구도 3.4 s 로 2 s 기준을 넘는다 | 3.1. 결정은 기준점 이후 편집에 2 s 를 적용한다고만 하므로 결과를 기록하고 대응은 남긴다 |

## 8. 검증

검증 시점: 코드 마지막 커밋 3a86b08 + 이 문서 커밋(문서·측정 도구만 추가).

| 명령 | 결과 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 성공(잠금 파일 변경 없음) |
| `pnpm exec turbo run build typecheck test test:e2e --force` | 25/25 작업 성공, 캐시 0 |
| 단위 시험 | shared-types 4, layout-recon 60, reflow 60, pdf-ops 451, core 301(+11), viewer-ui 302, extension 81(+7), spike-m0 33. 합계 1,292 통과, 16 건너뜀 |
| e2e | 1회째(turbo) 143 통과·5 건너뜀(+2), 2회째(`pnpm --filter @pdf-editor/extension test:e2e`) 143 통과·5 건너뜀 |
| `pnpm lint` | 오류 0 |
| `pnpm exec prettier --check .` | 통과 |
| `pnpm --filter @pdf-editor/extension package` + `verify-dist --release` | 성공, `release OK`. zip 7,156,499 B(상한 15 MiB), 스테이징 15,694,389 B(상한 25 MiB). 스토어 번들에 `benchProbeHeap`·`probeWasmHeap` 없음(새 검사 포함) |
| 재현 명령(R4) | zen 20건·kogl 100건 모두 재적용 성공(2.3절) |
| 코퍼스 옵트인 `REPLAY_CORPUS_DIR=… vitest run test/replay-corpus.test.ts` | zen 통과, kogl 은 `REPLAY_CORPUS_LONG=1` 옵트인(재현 명령으로 대신 확인) |

## 9. 남은 일

| # | 내용 | 담당 |
| --- | --- | --- |
| 1 | Windows 기준 PC 측정(측정 페이지 메모리 입력 3회: 기준점·종료 직후·30초 뒤), 쪽 판정 중앙값 > 1.0 s(재진입 200 ms)이면 D1 대체안 구현(사전 승인) | 사용자 → 후속 |
| 2 | kogl-mods-cpi-202609 메모리(5절): core 쪽 캐시 크기 상한·이웃 쪽 세그먼트 모델 보관·레이아웃 일시 할당. WASM 증가는 저널(9쪽 편집)이라 시나리오 구성 문제 | 후속 조사 |
| 3 | synthetic-objects-2000 탭 증가 170.6 MiB(30 s 뒤) 원인 | 후속 조사 |
| 4 | 기준점 이후 편집 재적용 시간: 1.2 MB 쪽 1건당 약 0.35 s(재적용마다 쪽 추출·원본 연결·레이아웃 재계산). 2 s 를 넘는 경우(저장 뒤 약 5건 초과) 대응 여부 | 메인 세션 결정 |
| 5 | F1 shared-types 선택 인자 승인, F2 메모리 정의 해석 확인 | 메인 세션 |
| 6 | 레이아웃 복원이 커밋한 블록 끝 글자를 다음 문단에 붙이는 경우(R4 원인, `fixedGroups` 힌트 미적용 사례) 자체 | 후속(재적용은 이번 수정으로 우회) |
