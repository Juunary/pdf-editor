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
| A3-6 | 전체 저장 옵션 **`garbage=yes,compress`** | 피크 WASM 힙이 compact 와 같고 출력만 46–70 B 크다. compact·deduplicate 의 MuPDF 결함 경로(mupdf.js#201)를 타지 않는다 | 구현(9c382cf) |
| A2-3 | 이미지 XObject `resolve()` 금지는 **별도 코드 규칙을 두지 않는다** | A3-6 으로 저장 시 위험이 사라졌다. MuPDF 동작 변화는 `tools/spike-m0/test/mupdf-pitfalls.test.ts` 가 감지 | 확정 |
| A7-1 | 폴백 폰트만 서브셋(`subsetFontBytes`, 편집 문서에서 `subsetFonts()` 미사용) | 임시 문서 서브셋으로 2,556,960 B → 100–105 KB, gid 유지·렌더 동일, 원본 단순 폰트 불변(테스트) | 구현(9231863) |
| A7-3 | Form BBox·MediaBox 사각형 정규화(`toRect`) | 실제 문서 BBox `[0 792 612 0]` 4/9 에서 pageBox·BBox 판정 오류 해소 | 구현(400de8d) |
| A5-1 | 가로채기 경계 150 | Chrome for Testing 150.0.7871.0 이상 `chrome.mimeHandler`. 판정은 API 유무라 동작 변화 없음 | 구현(14d58cd) |
| A5-2 | DNR 폴백 대상 자원에 `object` 추가 | CfT 140·149 에서 embed·iframe·object 3개 모두 뷰어로 리다이렉트·렌더(이전 iframe 1개) | 구현(14d58cd) |

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

M1 리뷰 반영 후(6절):

- 전진량의 글자 폭은 명세 폭(`PdfFont.advanceSpec`, 실수 /Widths·/W)이다. 소수 폭 폰트에서는 MuPDF 렌더의 뒤 글자가 반올림 오차만큼 움직이고 명세대로 그리는 뷰어에서는 그대로다. 같은 100블록 재측정(6.3) 결과는 위 표와 블록 단위로 같다.
- 건너뛰는 연산(사유 반환, 호출자는 redaction 대체 경로): Form 안, 클립 텍스트(Tr 4–7), 세로쓰기, Type3, 폰트 폭 불확실·MuPDF 대체 폰트(`font-encoding-unresolved`), CID 매핑 없는 코드, TJ 배열 안 연산자, `"` 피연산자 부족, Tf 크기 0·Tz 0.
- Tw 는 1바이트 코드 32 에만 더한다(폰트 종류 무관, MuPDF·명세 공통).
- 콘텐츠 스트림을 다른 쪽 /Contents 나 같은 배열의 다른 칸과 공유하면 사본을 만들어 이 쪽 칸만 바꾼다(`RemoveTextResult.copied`). /Contents 배열 자체를 공유하면 이 쪽에 새 직접 배열을 둔다.

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
| 1 | 코퍼스 도형 번호 불일치 11쪽(arXiv Type3 직접 실행, zen-ko-moon 이미지 Do) | 해소. 원인은 두 문서 모두 캐시 불가 Type3 글리프 직접 실행(`docs/m1-pdf-ops.md` 5.6). Type3 머지(15d9e76)와 리뷰 반영 후 core 재측정 실패 0쪽(6.3) |
| 2 | pdf-ops 정책 퍼징 테스트의 MuPDF WASM "memory access out of bounds" 간헐 중단(1회, 재실행 4회 통과) | 원인 조사. 후보: 테스트 헬퍼(`device-log.ts`·`page-model.ts`)의 `fillShade` 가 빌린 Shade 래퍼의 종료자를 해제하지 않아, GC 시점에 셰이드 참조를 한 번 더 놓는 경로(core 는 같은 문제를 `extract.ts` 에서 해제로 막았다). M1 리뷰 반영에서 헬퍼도 공용 `releaseBorrowedShade` 로 해제. 인과는 미확인(재현 없음) |
| 3 | 마일스톤 리뷰(읽기 전용) → `m1` 을 `main` 에 머지(사용자 승인) | 리뷰 지적 반영 완료(6절). `main` 머지는 사용자 승인 대기 |

## 6. M1 리뷰 반영

읽기 전용 마일스톤 리뷰(기준 15d9e76)의 지적과 처리. 커밋은 모두 `m1` 브랜치(미푸시).

### 6.1 지적별 처리

| 등급 | 지적 | 처리 | 커밋 |
|---|---|---|---|
| HIGH | `removeTextShowOps` 가 클립 텍스트(Tr 4–7)를 빈 TJ 로 바꿔 클립이 사라짐(파란 칠 279 → 60,000 px) | 수정: 건너뛰고 사유 반환(redaction 대체 경로). PLAN.md 3.1 대체 경로 목록에 추가 | acadec8 |
| HIGH | 콘텐츠 스트림을 다른 쪽 /Contents·같은 배열의 다른 칸과 공유해도 제자리에서 고침(2쪽 머리말도 지워짐) | 수정: 전체 쪽 /Contents 사용 수(배열 안 중복 포함)를 세어 공유면 사본을 만들고 이 쪽 칸만 바꿈. 공유 /Contents 배열은 이 쪽에 새 직접 배열 | acadec8 |
| MEDIUM | TJ 전진량이 MuPDF 정수 폭(pdf_to_int) 기준이라 명세 뷰어에서 뒤 글자가 밀림 | 수정: `PdfFont.advanceSpec`(실수 폭) 추가, 매칭은 기존 정수 폭 유지. CID 매핑 없는 코드가 있는 연산은 건너뜀 | 0930c09, acadec8 |
| MEDIUM | 세로쓰기(wmode 1)에서 글자마다 앞 글리프의 quad | 수정: stext 원점 = Device 원점 + 세로 전진 벡터로 결합. core 세로쓰기 테스트 추가 | 4201b4e |
| MEDIUM | `pathCmd` 닫기마다 경로 전체 복사·역순 탐색(re 20,000개 4.7 s) | 수정: 마지막 m 인덱스 추적(0.05 s). 2 s 상한 회귀 테스트 | 8175594 |
| MEDIUM | `loadPage()` 쪽 래퍼·`readStream()` Buffer 래퍼 미해제 | 수정: `readStreamBytes`·`pageTransform`(복사·읽기 직후 destroy). content-interp·type3·pdf-fonts 외에 xobject 읽기·임시 쪽 래퍼도 해제 | 9aee80a |
| MEDIUM | 테스트 헬퍼 `fillShade` 의 빌린 Shade 래퍼 종료자 미해제 | 수정: pdf-ops `releaseBorrowedShade` 를 core·헬퍼가 공용. 퍼징 간헐 중단의 후보 원인으로 5절에 기록(인과 미확인) | 9aee80a |
| LOW | Tw 조건이 `subtype !== 'Type0'` | 수정: 1바이트 코드 32(디코드 길이로 판정) | acadec8 |
| LOW | hail-mary 대체 폰트·`font-encoding-unresolved` 연산을 지움 | 수정: 건너뜀 | acadec8 |
| LOW | Resources·Font Null, `"` 피연산자 수 미검사 | 수정: 예외 없이 건너뜀. TJ 배열 안 연산자도 건너뜀 | acadec8 |
| LOW | linkPage 의 `unmatched` 표시가 버려지는 임시 SourceMap 에 남음 | 수정: 세션이 쪽 SourceMap 캐시(같은 무효화), 뷰어는 linkPage 뒤 getSourceMap 호출(생성 1회) | b7c32dd |
| LOW | `subsetFontBytes` 가 CFF(FontFile3)에서 일반 예외 | 수정: `UnsupportedFontError`(cff-outlines·no-fontfile2), TrueType 전용 명시. 서브셋 없는 `embedFont` 는 M0 CFF 대조 측정이 쓰므로 막지 않음 | 70768d1 |
| LOW | guard 가 건너뛴 Text 래퍼 미해제 | 수정 | c8870a7 |
| LOW | 추출 후 `setLog(null)` 로 이전 로거를 지움 | 주석으로 기록: mupdf.js 1.28.1 은 현재 로거를 읽는 API 가 없다. 저장소 안 `setLog` 사용처는 이곳뿐 | c8870a7 |
| LOW | 구조화 텍스트 글자마다 만드는 Font 래퍼 미해제 | 수정 | c8870a7 |
| LOW | 새 문서를 연 뒤에 이전 뷰어 unmount | 수정: `pdf.open` 전에 unmount, e2e 추가 | c89f98d |
| LOW | `Math.min(...seqs)` 전개 인자 한도(약 13만) | 수정: 반복으로 계산 | 8175594 |
| 보류 | 검색 결과 번호가 검색 시작 쪽 기준 | 보류: 표시 정책 결정(문서 순서 번호로 바꿀지)이며 기능 오류 아님. M2 뷰어 작업에서 Chrome 기본 뷰어와 대조 후 결정 | — |
| 보류 | MuPDF "CTM CHANGE IN CLIP TEXT" 해석 중단 시 부분 모델 | 보류: 중단 전까지의 모델과 MuPDF 경고를 돌려준다. 코퍼스 1,647쪽에서 쪽 예외·실패 0. 편집 제한 표시는 M3 편집 제한 UI 와 함께 | — |
| 보류 | 소프트 마스크 안에서 `#patternPaint` 판정 | 보류: 리뷰·이번 작업 모두 재현 못 함. 마스크 안 콜백은 guard 가 건너뛴다. 소프트 마스크 + 패턴 색 텍스트 조합을 퍼징에 넣은 뒤 판단 | — |

### 6.2 검증(2026-10-19, `m1` c89f98d 기준 강제 실행)

| 명령 | 결과 |
|---|---|
| `pnpm exec turbo run build typecheck test test:e2e --force` | 19/19 작업 성공(캐시 0). 단위: pdf-ops 310 통과·2 건너뜀(코퍼스 러너), core 114·1, viewer-ui 117, extension 21, spike-m0 31·1, shared-types 1. e2e 27 통과·1 건너뜀 |
| `pnpm lint` | 통과 |
| `pnpm exec prettier --check .` | 통과 |

### 6.3 코퍼스 재측정(`fixtures/corpus` 19건 1,647쪽)

```
NODE_OPTIONS=--max-old-space-size=12288 CORE_LINK_MEASURE_DIR=<코퍼스> CORE_LINK_MEASURE_OUT=<경로> pnpm --filter @pdf-editor/core exec vitest run test/corpus-link.test.ts
NODE_OPTIONS=--max-old-space-size=8192 TEXT_REMOVE_CORPUS_DIR=<코퍼스> TEXT_REMOVE_OUT=<경로> pnpm --filter @pdf-editor/pdf-ops exec vitest run test/text-remove-corpus.test.ts
```

| 측정 | 쪽 | 글자 | 미매칭 글자 | 글리프 총수 차이 | 도형 | 미매칭 도형 | 도형 총수 차이 | 실패 쪽 | 쪽 예외 |
|---|---|---|---|---|---|---|---|---|---|
| core first-arrival, 2절(Type3 머지 전) | 1,647 | 4,126,758 | 0 | 0 | 182,110 | 686 | 1,210 | 11 | 0 |
| core first-arrival, 리뷰 반영 후 | 1,647 | 4,126,758 | 0 | 0 | 182,110 | 0 | 0 | 0 | 0 |

- 실행 시간 49 s, 열기 실패 0.
- A7-2 100블록 재측정(명세 폭·새 건너뜀 규칙): SourceMap 제거 블록 밖 렌더 변화 0 px 93/100, 블록 안 남은 글자 0 89/100, 지운 연산 1,950·건너뛴 연산 78. 이전 측정과 블록 단위로 같다. redaction 79/100 도 같다.

