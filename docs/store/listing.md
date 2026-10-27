# 등록 설명(초안)

## 이름

PDF Editor (가칭). 상표 검색은 사용자가 합니다([assets.md](assets.md) 5절).

## 요약(132자 이하)

매니페스트에 현지화 반영(2026-10-26): `apps/extension/_locales/{en,ko}/messages.json` 의 `appDescription` 이 아래 문구와 같고(`appName` 은 두 언어 모두 "PDF Editor"), 매니페스트는 `__MSG_appName__`·`__MSG_appDescription__`·`default_locale: "en"` 입니다. 문구를 바꾸면 두 곳을 함께 고칩니다(`apps/extension/test/release.test.ts` 가 일치를 검사).

| 언어 | 문구 | 글자 수 |
| --- | --- | --- |
| 한국어 | Chrome 에서 PDF 를 열어 글자 선택·검색, 문단·표 셀·도형 편집, 저장까지 기기 안에서 처리합니다. | 61 |
| English | Open PDFs in Chrome to select, search, edit paragraphs, table cells and shapes, and save. All local. | 100 |

## 상세 설명 — 한국어

PDF Editor 는 Chrome 에서 PDF 를 열면 바로 편집할 수 있는 뷰어입니다. PDF 는 브라우저 안에서만 처리되며 서버로 전송되지 않습니다.

기능
- PDF 열기: 웹과 로컬 PDF 를 이 뷰어로 엽니다.
- 글자 선택·복사, 문서 전체 검색(Ctrl+F)
- 문단 편집: 문단을 고치면 영역 안에서 다시 배치합니다. 한글 입력 지원
- 표 셀 편집: 셀 하나의 텍스트 수정
- 벡터 도형 편집: 이동·크기·점 이동, 선 두께, 채움·선 색, 삭제
- 되돌리기·다시 실행, 편집 가능 여부 표시(제한 사유 포함)
- 저장: 사용자가 고른 파일에 저장

제한
- 편집할 수 없는 문단·셀·도형은 사유를 표시합니다. 스캔 이미지 속 글자는 편집·검색할 수 없습니다.
- 큰 문서는 저장 때 메모리를 많이 쓰며, 한계를 넘을 것으로 예상되면 저장하지 않고 안내합니다.
- Chrome 151 이상에서 동작합니다.

오픈소스(AGPL-3.0-or-later): https://github.com/Juunary/pdf-editor

## 상세 설명 — English

PDF Editor is a viewer that lets you edit a PDF right after opening it in Chrome. PDFs are processed inside the browser and are never uploaded.

Features
- Opens web and local PDFs in this viewer.
- Text selection and copy, document-wide search (Ctrl+F).
- Paragraph editing with reflow inside the edit area; Korean input supported.
- Table cell text editing, one cell at a time.
- Vector shape editing: move, resize, move points, line width, fill/stroke color, delete.
- Undo/redo and editable-area marks with the reason for each restriction.
- Saves to a file you choose.

Limitations
- Content that cannot be edited shows a reason. Text inside scanned images cannot be edited or searched.
- Large documents need a lot of memory when saving; the viewer refuses to save when the estimate exceeds the limit.
- Requires Chrome 151 or later.

Open source (AGPL-3.0-or-later): https://github.com/Juunary/pdf-editor

## 분류·언어

| 항목 | 권고 |
| --- | --- |
| 카테고리 | 생산성(Productivity) |
| 기본 언어 | 영어(매니페스트 `default_locale: "en"`, 사용자 결정 2026-10-26), 한국어 추가 |

대시보드 입력 시 주의: 등록 정보(상세 설명·스크린샷·프로모션 타일)는 언어별로 따로 입력합니다. 기본 언어 영어 항목에 영어 상세 설명을, 한국어 항목에 한국어 상세 설명을 넣습니다. 이름·요약은 패키지의 `_locales` 에서 언어별로 읽히므로 대시보드 값과 위 표가 같은지 제출 전에 확인합니다.
