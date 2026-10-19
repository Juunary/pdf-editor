# M2 레이아웃 복원 계약

작성 2026-10-19. 대상: `packages/layout-recon`, `packages/core`(`getPageLayout`), `packages/shared-types/src/page-layout.ts`.
PLAN.md 4절 M2(문단/열/표 복원, 읽기 순서, 정답 라벨 기반 정확도 하네스, A7-6·A7-10)의 구현 계약이다.

## 1. 범위와 경계

| 항목 | 내용 |
| --- | --- |
| 입력 | `PageModel`(core `extractPage({ pageIndex, includePathSegments: true })`). M1 계약(`docs/m1-contract.md`) 그대로 |
| 출력 | `PageLayout`(쪽 단위). PLAN.md 의 `DocumentModel` 은 `{ pages: PageLayout[] }` |
| 순수성 | `layout-recon` 은 MuPDF·DOM 에 의존하지 않는다. `@pdf-editor/shared-types` 의 타입만 import 한다 |
| 호출 | 뷰어 → Worker `getPageLayout(pageIndex)` → `PdfSession` 이 추출 캐시를 거쳐 `reconstructPage` 호출, 결과를 쪽 단위 캐시 |
| 좌표 | 페이지 공간(렌더 방향, 원점 왼쪽 위, y 아래로 증가). 회전 쪽도 렌더된 방향 기준으로 복원한다 |
| 쪽 경계 | 쪽 하나만 본다. 쪽 사이 반복(러닝헤드)·쪽 넘김 문단 연결은 v1 범위 밖(5절 미결) |

### 1.1 MuPDF stext 옵션 판정(PLAN.md 2절 "레이아웃 복원" 행)

PLAN.md 는 stext 옵션(`segment`, `paragraph-break`, `table-hunt`, `structured`) 출력을 자체 복원의 입력으로 쓰도록 했다. 2026-10-19 실측(`fed-h41-current` 2쪽, `table-hunt,segment`):

- 표 영역은 `Table/TR/TD` 구조로 찾았으나 12개 데이터 행을 셀 하나(줄 12개)로 합쳤다.
- 표 아래 각주 목록(번호 열 + 본문 열)을 표로 보고했다.
- 같은 표의 오른쪽 열(`Wednesday`)은 다른 `Div` 로 분리됐다.

판정: v1 은 이 출력을 입력으로 쓰지 않고 `PageModel`(기본 stext 줄 + Device 경로·이미지)만 쓴다. 옵션 출력은 정확도 하네스에서 실패 유형을 모은 뒤 보조 신호 후보로 다시 본다(PLAN.md 7절 4).

## 2. 출력 불변식

### 2.1 소속

- 보이는 글자(공백 아닌 `text`)가 하나 이상 있는 `PageModel.lines` 의 줄은 **정확히 한 문단** 에 속한다. 나머지 줄은 `unassignedLines`.
- 문단은 셋 중 하나에 담긴다: 본문 흐름(`table = null`, `figure = null`), 표 셀(`table` = 표 id), 도형 라벨(`figure` = 도형 id).
- `readingOrder` 는 최상위 항목만 담는다: 흐름 문단, 표, 도형. 각 문단·표·도형은 정확히 한 번 나온다. 표 안 문단은 셀 행 우선, 도형 라벨은 `LayoutFigure.labels` 순서.
- `chars` 는 문단 줄들의 `LineInfo.chars` 를 줄 순서대로 이은 것이다. `CharInfo.line = -1` 인 글자는 레이아웃에 없다.
- 모든 id 는 해당 배열의 인덱스와 같다(`paragraphs[k].id === k`).

### 2.2 기하

- 문단 `bbox` = 줄 `bbox` 합집합. 표 `bbox` = 경계선(`rowBounds`·`colBounds`) 외곽. 도형 `bbox` = 구성 이미지·경로·라벨 합집합.
- `lineHeight` = 이웃 줄 기준선 간격의 중앙값(pt). 한 줄이면 null.
- `firstLineIndent` = 첫 줄 왼쪽 − 나머지 줄 왼쪽 중앙값(pt). 내어쓰기는 음수. 한 줄이면 0.
- `align`: 마지막 줄을 뺀 줄의 왼쪽·오른쪽·가운데 정렬 편차로 판정한다. 줄이 2개 미만이면 `unknown`.

### 2.3 텍스트

- 줄 텍스트 = 글자 `text` + `spaceAfter` 위치마다 공백 하나, 끝 공백 제거(M1 계약 4절과 같은 줄 안 규칙).
- 문단 텍스트 = 줄 텍스트를 공백 하나로 잇는다. 줄 끝이 `-` 이면 공백 없이 잇고 하이픈은 남긴다(제거 여부는 M3 리플로우가 판단).
- 문단 안 줄바꿈은 원본 배치의 결과로 보고 텍스트에 남기지 않는다. 복사 조립(M1 계약 4절의 줄 사이 `\n`)은 바꾸지 않는다.

### 2.4 모양 구간(`styleRuns`)

- `start`·`end` 는 `LayoutParagraph.chars` 위치 `[start, end)`. 구간은 겹치지 않고 빈틈 없이 `[0, chars.length)` 를 덮는다.
- 이웃 구간은 (fontId, size 0.1pt 반올림, bold, italic, color) 중 하나 이상이 다르다. 공백 글자는 앞 구간에 붙인다.

### 2.5 역할(`role`)

| 역할 | 판정 요지 |
| --- | --- |
| `header`·`footer` | 위·아래 여백 띠(쪽 높이 9%) 안, 본문과 줄 간격의 2배 이상 떨어진 짧은 문단. 쪽 번호 형식(숫자, `- 3 -`, `Page 3`, `3 / 10`) 우대 |
| `heading` | 본문 중앙값보다 1.15배 이상 크거나, 굵고 짧은(본문 열 폭 70% 이하) 1–2줄 문단 |
| `list-item` | 첫 줄이 글머리(•, ◦, ▪, –, -, *, ①, (1), 1., a), 가.)로 시작 |
| `caption` | `Figure`·`Fig.`·`Table`·`그림`·`표` + 번호로 시작하고 도형·표에 인접 |
| `footnote` | 흐름 맨 아래, 본문보다 작고 번호·기호로 시작 |
| `body`·`other` | 나머지 가로 줄은 `body`, 세로·회전 줄은 `other` |

## 3. 복원 단계

상수는 `packages/layout-recon/src/constants.ts` 에 이름을 붙여 둔다. 아래 값은 초기값이며 정확도 하네스 개발 세트로만 조정한다(4.4).

1. **줄 특징**(`lineFeatures`): 크기 중앙값, 다수 폰트, 기준선, 방향, 단어 상자(공백), 구간 상자(글자 크기 1.5배 넘는 간격).
2. **경로 정규화**: `segments` 를 페이지 공간으로 옮겨 수평·수직 선분(두께 2pt 이하 채움 사각형 포함)과 그 밖의 도형 경로로 나눈다.
3. **표**
   - 괘선 전략(PyMuPDF `find_tables` lines 전략 포팅): 선분 스냅(3pt)·이음(3pt) → 교차점 → 최소 셀 → 연결된 셀 묶음 = 표. 2행·2열 이상이고 글자가 있는 것만.
   - 정렬 전략(text 전략): 괘선 표 밖에서, 구간이 3개 이상인 줄이 3줄 이상 이어지고 구간 왼쪽·오른쪽·가운데가 줄 사이에 정렬되면 표. 열 경계는 정렬 구간 군집, 행은 기준선 군집.
   - 셀 안 줄은 셀별 문단으로 묶는다(5단계 규칙을 셀 안에서 적용).
4. **도형**: 이미지(쪽 면적 0.5% 이상, 글자 절반 이상을 덮는 배경·스캔 이미지는 제외)와 벡터 군집(표 괘선·배경 사각형 제외 경로를 5pt 이내로 묶고 쪽 면적 1% 이상). 도형 안의 짧은 줄은 라벨 문단.
5. **흐름 문단**
   - 같은 행 조각 합치기: 기준선이 같고 간격이 글자 크기 이하인 줄 조각.
   - 영역 쌓기: 위 줄과 x 가 겹치고(좁은 쪽 폭의 50%) 세로 간격이 줄 간격 2배 이하이면 같은 영역. 위 줄 아래에 같은 행 줄이 둘 이상이면(여러 열에 걸친 줄) 잇지 않는다.
   - 영역 안 문단 나누기: 줄 간격이 영역 중앙값의 1.15배 초과, 들여쓰기(글자 크기 0.5배 이상), 앞 줄이 짧음(열 폭 85% 미만)·문장 끝, 글머리, 크기·굵기 변화.
6. **열·읽기 순서**: 영역·표·도형 상자에 XY-cut. 세로 빈 띠(4pt 이상)가 있으면 세로로 먼저 자르고, 없으면 가로로 자른다. 세로 자르기로 나뉜 잎이 열(`LayoutColumn`)이다. 머리 → XY-cut 순서 → 꼬리.
7. **열 넘김 연결**(`continuesTo`): 읽기 순서상 다음 흐름 문단이 다른 열의 맨 위에 있고, 앞 문단 마지막 줄이 열 폭 끝까지 차고 문장 끝이 아니며, 다음 문단 첫 줄이 들여쓰기 없이 소문자·한글로 시작하면 연결한다.
8. **ML 슬롯**: `ReconOptions.plugins` 의 `LayoutPlugin.proposeRegions(model)` 이 표·도형·문단 후보를 내면 3–5단계가 휴리스틱 후보와 함께 쓴다. v1 은 인터페이스만 두고 기본 구현은 없다(PLAN.md 2절 ML 행).

## 4. 정확도 하네스

### 4.1 정답 라벨

- 위치 `fixtures/labels/<문서 id>/p<쪽 0부터 3자리>.json`. 코퍼스 PDF 는 커밋하지 않으므로 라벨은 줄 인덱스와 상자만 담고 본문 텍스트는 담지 않는다.
- 추출 지문: `lineCount` 와 `linesSha256`(줄 텍스트를 `\n` 으로 이은 UTF-8 SHA-256). 하네스는 지문이 다르면 그 쪽을 채점하지 않고 실패로 보고한다(추출 변경 시 라벨 재확인).
- 보이는 줄(텍스트가 공백만이 아닌 줄)은 문단 `lines`·표 `lines`·도형 `labels`·`ignoreLines` 중 정확히 한 곳에 둔다(`scripts/layout-labels/validate-labels.mjs` 가 검사).
- 문단 경계·역할·순서 판단 기준: `docs/m2-labeling-guide.md`.
- 상태: `draft`(라벨러 작성) → `reviewed`(독립 검토자 승인) → `confirmed`(사람 확인). PLAN.md 6절에 따라 `reviewed` 이상만 정확도 수치에 쓴다. 사람 확인 전 수치는 "검토자 승인 라벨 기준" 으로 표기한다.

```jsonc
{
  "doc": "nasa-eo-2024-janfeb", "pageIndex": 4, "split": "dev",
  "extract": { "lineCount": 87, "linesSha256": "…" },
  "status": "reviewed", "labeledBy": "…", "reviewedBy": "…", "notes": "…",
  // 최상위 읽기 순서. 표·도형 안 줄은 해당 항목에만 둔다.
  "items": [
    { "type": "paragraph", "role": "header", "lines": [0] },
    { "type": "paragraph", "role": "heading", "lines": [1, 2] },
    { "type": "table", "bbox": [x0, y0, x1, y1], "rows": 5, "cols": 3, "lines": [10, 11, 12],
      "cells": [{ "row": 0, "col": 0, "rowSpan": 1, "colSpan": 1, "lines": [10] }] },  // cells 는 선택
    { "type": "figure", "bbox": [x0, y0, x1, y1], "labels": [30, 31] },  // labels = 도형 안 줄
    { "type": "paragraph", "role": "body", "lines": [3, 4, 5] }
  ],
  "ignoreLines": [] // 판단 불가 줄(채점 제외)
}
```

### 4.2 지표

| 지표 | 정의 |
| --- | --- |
| 문단 F1 | 흐름 문단(머리·꼬리 포함)의 줄 집합 완전 일치. 정밀도 = 일치 / 예측 수, 재현율 = 일치 / 라벨 수 |
| 줄 쌍 F1 | 같은 문단에 든 줄 쌍(라벨 vs 예측)의 F1. 경계 하나 틀림의 부분 점수 |
| 읽기 순서 τ | 라벨 최상위 항목 순서와 예측 순위(항목 줄의 예측 순위 중앙값) 사이 Kendall τ. 머리·꼬리 제외 |
| 표 검출 P/R | 상자 IoU 0.5 이상 일대일 매칭 |
| 표 구조 | 매칭된 표의 행 수·열 수 일치율, 셀 라벨이 있으면 셀 줄의 (행, 열) 일치율 |
| 도형 검출 P/R | 상자 IoU 0.5 이상 일대일 매칭 |
| 머리·꼬리 F1 | 줄 단위, 역할 `header`·`footer` |

### 4.3 M2 완료 목표(측정 전 고정)

| 지표 | 목표(시험 세트, 쪽 평균 아닌 전체 합산) |
| --- | --- |
| 문단 F1 | ≥ 0.85 |
| 읽기 순서 τ(쪽 평균) | ≥ 0.85 |
| 표 검출 P·R | 각 ≥ 0.75 |
| 표 행·열 일치율 | ≥ 0.6 |
| 머리·꼬리 F1 | ≥ 0.85 |

목표 미달 지표는 실패 유형을 분류해 남기고 ML 옵트인 판단 입력으로 넘긴다(PLAN.md 7절 4). 목표는 결과를 본 뒤 바꾸지 않는다.

### 4.4 개발·시험 세트

- 라벨 쪽을 문서 유형별로 나눠 약 2/3 를 `dev`, 1/3 을 `test` 로 정한다(라벨 파일 `split`).
- 상수 조정과 실패 분석은 `dev` 로만 한다. `test` 는 마일스톤 끝 측정에서 한 번 보고한다.
- 하네스: `packages/core/test/layout-accuracy.test.ts`(환경 변수 `LAYOUT_CORPUS_DIR` 이 있을 때만, 결과 JSON 은 `LAYOUT_ACC_OUT`). 채점 함수는 `layout-recon` 의 `scoreLayout`(단위 시험 포함).

## 5. 미결·범위 밖

- 쪽 사이 러닝헤드 반복 판정, 쪽 넘김 문단 연결(`continuesTo` 는 같은 쪽만).
- 표 셀 병합(`rowSpan`·`colSpan`)은 괘선 전략에서만 1 초과를 낸다. 정렬 전략은 1 고정.
- 세로쓰기·회전 줄은 한 줄짜리 `other` 문단으로 두고 열·표 판정에서 뺀다.
- 태그 PDF 구조 트리(`structured`)는 쓰지 않는다(태그 정책은 M3 A7-7).
