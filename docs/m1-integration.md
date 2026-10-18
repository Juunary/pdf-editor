# M1 통합: 세 작업 브랜치 머지 · 통합 e2e · 하위 프레임 포커스 결함

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-19 |
| 브랜치 | `m1`(로컬, 미푸시) |
| 머지 | `m1-core`(906463f) → b99943b, `m1-pdf-ops`(cd5ecf8) → 008a439, `m1-viewer-ui`(e8c2074) → 48adcf1. 충돌 없음, 사용자 승인(2026-10-19) |
| 계약 | `docs/m1-contract.md` 수정 1–6 반영 상태로 세 브랜치가 머지됨 |

## 1. 검증 결과(실측 2026-10-19, 서버)

| 항목 | 결과 |
|---|---|
| `pnpm exec turbo run build typecheck test test:e2e --force` | 19개 태스크 성공 |
| 단위 테스트 | core 109, pdf-ops 271(1 건너뜀: 코퍼스 러너), viewer-ui 116, extension 21, spike-m0 21(1 건너뜀: git 밖 OTF), shared-types 1 |
| e2e(Playwright 번들 Chromium 156, 헤드리스) | 26건 통과, 건너뜀 0. 통합 시나리오 6건 포함 |
| lint · Prettier | 통과 |
| 실제 core `extractPage` + pdf-ops `buildSourceMap`·`linkPage`(`PdfSession.linkPage`) | fixtures/m0 6개 문서 10쪽: 글자·도형 매칭 100%, 원점 오차 0, 총수 차이 0 |

통합 시나리오 6건

| 시나리오 | 결과 |
|---|---|
| Ctrl+A 복사 = m0-sample.pdf 추출 텍스트(공백 접기) | 통과 |
| 첫 두 줄 드래그 복사 = 계약 4절 읽기 텍스트(다른 블록이면 빈 줄) | 통과(기대값 정정 후) |
| MIME handler 최상위(클릭 없이)·임베디드 iframe·embed(클릭 후) 복사 | 통과(포커스 결함 수정 후, 10회 연속) |
| Ctrl+F `paragraph` 5건, 하이라이트 상자 안 글자 = 검색어, Enter 순환, Esc | 통과 |
| Ctrl+F 한글 `검색과 복사` 1건(m0-spike-saved.pdf) | 통과 |
| 디버그 오버레이 매칭 실패 0, 툴팁에 연산·범위·제한 | 통과 |

## 2. 통합에서 찾은 결함과 수정

| # | 내용 | 수정 |
|---|---|---|
| I1 | 하위 프레임 키보드 포커스: MIME handler 뷰어는 PDF URL 페이지의 하위 프레임, 임베디드 뷰어는 embed·iframe·object 안의 프레임이다. 텍스트 층이 직접 선택을 위해 마우스 누름 기본 동작을 막아, 클릭해도 프레임으로 포커스가 옮겨 가지 않았다. Ctrl+A·C·F 가 바깥 문서로 가서 복사·검색이 되지 않았다(PDF 링크로 여는 주 경로) | 텍스트 층 요소(tabIndex -1)에 직접 포커스, 프레임에 포커스가 없으면 `window.focus()`(`TextLayer.tsx`). 최상위 MIME handler 는 열자마자 `window.focus()`(`main.ts`)로 Chrome 기본 뷰어처럼 클릭 없이 단축키 동작. 임베디드는 바깥 페이지 포커스를 빼앗지 않음 |
| I2 | 드래그 복사 e2e 기대값 | 블록 사이 빈 줄(계약 4절), 끝점을 줄 끝 바깥으로. 테스트만 수정 |
| I3 | 임베디드 e2e 좌표 클릭 경쟁 | 바깥 페이지 좌표 계산 대신 프레임 안 요소 클릭 + 클릭 후 포커스 확인, 렌더 완료 대기. 테스트만 수정 |

## 3. 남은 제한·미확인

| # | 내용 | 다음 조치 |
|---|---|---|
| U5 | `<object>` 임베디드 뷰어는 헤드리스 Chromium 156 에서 클릭 포커스가 간헐 실패(8회 중 3회). 자동 검증에서 제외 | Windows Chrome 수동 확인 |
| U6 | 한 페이지의 여러 임베디드 뷰어 사이 포커스 이동은 헤드리스에서 불안정해 자동 검증 범위 밖 | Windows Chrome 수동 확인 |
| U7 | Windows 실제 Chrome 에서 Ctrl+F·드래그 선택·Ctrl+C, 한글 IME 검색어 입력 | 사용자 확인(viewer-ui 문서 6절 3번) |

## 4. M1 남은 작업

| # | 내용 | 비고 |
|---|---|---|
| 1 | 코퍼스 매칭 실패율 측정: `fixtures/corpus` 19건·1,647쪽에서 실제 core PageModel 로 first-arrival·no-clip 두 정책 측정(`@pdf-editor/pdf-ops/measure`) | 결과로 클립 텍스트 계수 정책을 사용자께 재확인 |
| 2 | M1 결정 항목: A1-1(Form 페이지 직접 편집 후처리), A1-3(Resources 상속 Form), A2-3·A3-6(이미지 resolve 금지 코드 규칙·`garbage=yes`), A7-2(텍스트 제거 경로) | 설계 결정 |
| 3 | M1 구현 항목: A7-1(폴백 폰트만 서브셋), A7-3(사각형 정규화), A5-1·A5-2(가로채기 경계 150·DNR object) | PLAN.md v2.6 6절 |
| 4 | 마일스톤 리뷰(구현 맥락과 분리한 읽기 전용 세션) | 계약 6절 4 |
| 5 | `m1` → `main` 머지: 양쪽 모두 `pnpm-lock.yaml` 이 바뀌었다(main: pdfjs-dist, m1: viewer-ui·preact). 머지 시 `pnpm install` 로 lockfile 재생성 | 사용자 승인 후 |
