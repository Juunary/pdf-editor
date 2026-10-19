# M1 결정 항목과 근거

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-19 |
| 범위 | `docs/m1-integration.md` 4절의 M1 남은 작업: 코퍼스 정책 측정, 결정 A1-1·A1-3·A2-3·A3-6·A7-2, 구현 A7-1·A7-3·A5-1·A5-2 |
| 근거 데이터 | 실제 코퍼스 19건·1,647쪽(`fixtures/corpus`, git 밖), 측정 결과 `out/m1-corpus/`(git 제외). 재현 명령은 각 절 |
| 측정 환경 | 서버 `sailab01`, Node 22.18, npm `mupdf` 1.28.1 |

## 1. 결정 요약

| ID | 결정 | 근거 요약 | 상태 |
|---|---|---|---|
| V3 정책 | 클립 텍스트 계수는 **첫 등장 계수 유지**(계약 3.1) | 실제 코퍼스에서 첫 등장 계수(실제 core)와 클립 미계수(헬퍼)의 결과가 같다: 글자 4,126,758개 미매칭 0, 글리프 총수 차이 0, 실패 11쪽 동일(전부 도형) | 확정 |
| A7-2 | 텍스트 제거는 **SourceMap 기반 제거(`removeTextShowOps`)를 M3 기본 경로**로 한다. MuPDF redaction 은 이 함수가 건너뛰는 경우의 대체 경로 | 100블록 비교에서 SourceMap 제거는 블록 밖 글자 위치 변화 0/100, redaction 은 블록 밖 렌더 변화 21/100(최대 5,685 px). M0 C2 쪽에서 redaction 5,565–21,970 px vs SourceMap 0 px | 확정, 함수 구현 |
| A1-1 | Form 이 있는 페이지의 직접 편집 후처리는 **불필요**. A7-2 로 페이지 redaction 을 쓰지 않으므로 MuPDF 가 그 쪽의 모든 Form 을 인스턴스화하지 않는다. Form 안 텍스트는 M3 에서 "편집 위치 인스턴스 복제 + 복제본 스트림에 SourceMap 기반 제거" 로 하고, `redactFormUsage` 는 대체 경로로 둔다 | A7-2 결과 | 확정 |
| A1-3 | Resources 를 상속하는 Form(L1)은 **v1 편집 제한 유지** | 코퍼스의 L1 Form 86개는 모두 한 문서(arXiv)이고 텍스트가 없다. 보강 코퍼스(A7-10)에서 텍스트 Form 이 나오면 인스턴스에 컨테이너 리소스를 복사하는 방식으로 해소 | 확정 |
| A3-6 | 전체 저장 옵션 **`garbage=yes,compress`** | 피크 WASM 힙이 compact 와 같고 출력만 46–70 B 크다. compact·deduplicate 의 MuPDF 결함 경로(mupdf.js#201)를 타지 않는다 | 구현(dc400b2) |
| A2-3 | 이미지 XObject `resolve()` 금지는 **별도 코드 규칙을 두지 않는다** | A3-6 으로 저장 시 위험이 사라졌다. MuPDF 동작 변화는 `tools/spike-m0/test/mupdf-pitfalls.test.ts` 가 감지 | 확정 |
| A7-1 | 폴백 폰트만 서브셋(`subsetFontBytes`, 편집 문서에서 `subsetFonts()` 미사용) | 임시 문서 서브셋으로 2,556,960 B → 100–105 KB, gid 유지·렌더 동일, 원본 단순 폰트 불변(테스트) | 구현(b21f63a) |
| A7-3 | Form BBox·MediaBox 사각형 정규화(`toRect`) | 실제 문서 BBox `[0 792 612 0]` 4/9 에서 pageBox·BBox 판정 오류 해소 | 구현(80c4671) |
| A5-1 | 가로채기 경계 150 | Chrome for Testing 150.0.7871.0 이상 `chrome.mimeHandler`. 판정은 API 유무라 동작 변화 없음 | 구현(edde23a) |
| A5-2 | DNR 폴백 대상 자원에 `object` 추가 | CfT 140·149 에서 embed·iframe·object 3개 모두 뷰어로 리다이렉트·렌더(이전 iframe 1개) | 구현(edde23a) |

## 2. 코퍼스 매칭 측정(계약 6절 3)

재현

```
CORE_LINK_MEASURE_DIR=<코퍼스> CORE_LINK_MEASURE_OUT=out/m1-corpus/core-first-arrival pnpm --filter @pdf-editor/core exec vitest run test/corpus-link.test.ts
NODE_OPTIONS=--max-old-space-size=12288 LINK_MEASURE_DIR=<코퍼스> LINK_MEASURE_OUT=out/m1-corpus/helper-no-clip LINK_MEASURE_POLICIES=no-clip pnpm --filter @pdf-editor/pdf-ops exec vitest run test/corpus-measure.test.ts
```

| 정책 · PageModel | 쪽 | 글자 | 미매칭 글자 | 글리프 총수 차이 | 도형 | 미매칭 도형 | 실패 쪽 | 쪽 예외 |
|---|---|---|---|---|---|---|---|---|
| 첫 등장 계수 · 실제 core | 1,647 | 4,126,758 | 0 | 0 | 182,110 | 686 | 11 | 0 |
| 클립 미계수 · pdf-ops 헬퍼 | 1,647 | 4,126,758 | 0 | 0 | 182,110 | 686 | 11 | 0 |

- 실패 11쪽은 전부 도형 번호(paintSeq) 총수 차이다: arxiv-2609.10511 3쪽(2·3·6), zen-ko-moon-21973474 8쪽(0·6·8·13·16·18·19·20). arXiv 는 Type3 비트맵 폰트 글리프 프로시저 직접 실행(pdf-ops R1), zen-ko-moon 은 이미지 XObject Do 주변으로 추정. pdf-ops 작업에 조사·수정을 요청했다(진행 중).
- 실행 시간: core 측정 52 s(1,647쪽). 헬퍼 두 정책 동시 측정은 Node 기본 힙에서 메모리 부족 → 정책별로 나누고 힙을 늘려 실행.

## 3. 텍스트 제거 경로 비교(A7-2)

재현

```
NODE_OPTIONS=--max-old-space-size=8192 TEXT_REMOVE_CORPUS_DIR=<코퍼스> TEXT_REMOVE_OUT=out/m1-corpus/text-remove.json pnpm --filter @pdf-editor/pdf-ops exec vitest run test/text-remove-corpus.test.ts
```

방법: 문서마다 2쪽(1·4), 쪽마다 구조화 텍스트 블록 최대 3개(여러 줄 블록 우선, 줄마다 블록을 나누는 출력기는 넓은 한 줄 블록). 블록 안 글리프만 가진 페이지 콘텐츠 텍스트 연산을 (A) `removeTextShowOps`, (B) MuPDF 주석 단위 redaction(텍스트 제거, 이미지·선화 보존)으로 지우고 전체 저장 후 비교.

| 지표(100블록·19문서) | SourceMap 제거 | MuPDF redaction |
|---|---|---|
| 블록 밖 공백 제외 글자의 종류·위치 변화 | **0/100** | 측정 안 함 |
| 블록 밖 렌더 변화 0 px(여백 2 px, 채널 차 8 초과) | 93/100 | 79/100 |
| 블록 밖 렌더 변화가 있는 블록 | 7(전부 지운 글자 잉크가 블록 경계 밖, 글자 이동 0) | 21(중앙값 290 px, 최대 5,685 px) |
| 블록 안 남은 글자 0 | 89/100 | 98/100 |
| 지우지 못한 이유 | Type3 폰트 4블록(설계상 건너뜀), 블록 경계에 걸치거나 Form 안 연산을 측정이 고르지 않음 7블록 | — |

M0 C2 쪽(zen-ko-report 22·23쪽 6블록): SourceMap 제거 블록 밖 0 px·남은 글자 0, redaction 5,565–21,970 px.

`removeTextShowOps` 동작: 지울 Tj·TJ·'·" 연산의 바이트만 같은 총 전진량의 숫자 TJ 로 바꾼다(전진량 = 글자 폭·Tc·Tw·Tz·TJ 숫자 조정). 텍스트 행렬이 원래 자리에서 끝나 같은 BT 의 뒤 글자 위치가 바뀌지 않고, 스트림의 나머지 바이트는 그대로다(합성 테스트로 고정).

## 4. M3 로 넘기는 작업

| # | 내용 | 근거 |
|---|---|---|
| 1 | 연산 일부만 지우기: 문단 경계가 Tj·TJ 안에 있으면 글리프 경계에서 문자열을 나누고 지운 부분만 숫자 조정으로 바꾼다 | 3절(블록 경계 연산 미선택) |
| 2 | Form 안 텍스트: 편집 위치 인스턴스 복제 후 복제본 스트림에 `removeTextShowOps` 적용 | A1-1 |
| 3 | Type3·세로쓰기 텍스트 제거: Type3 는 /FontMatrix·/Widths 로 전진량 계산, 세로쓰기는 w1y 사용. 못 하면 redaction 대체 경로 | 3절 Type3 4블록 |
| 4 | 지운 텍스트의 marked content(ActualText·MCID)와 링크 주석 처리: 태그 정책(PLAN.md 1.4)·A2-1 과 함께 결정 | C2, A2-1 |
| 5 | 편집 후 같은 쪽 SourceMap 재생성(바이트 위치가 바뀌므로) 또는 교체 길이만큼 오프셋 갱신 | A7-2 |

## 5. 아직 남은 M1 항목

| # | 내용 | 상태 |
|---|---|---|
| 1 | 코퍼스 도형 번호 불일치 11쪽(arXiv Type3 직접 실행, zen-ko-moon 이미지 Do) | pdf-ops 작업 진행 중 |
| 2 | pdf-ops 정책 퍼징 테스트의 MuPDF WASM "memory access out of bounds" 간헐 중단(1회, 재실행 4회 통과) | 원인 조사 |
| 3 | 마일스톤 리뷰(읽기 전용) → `m1` 을 `main` 에 머지(사용자 승인) | 대기 |
