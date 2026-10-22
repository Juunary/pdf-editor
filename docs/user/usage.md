# 사용법

PDF 를 Chrome 에서 열면 이 확장의 뷰어가 열립니다. 문서는 한 번에 한 쪽씩 보입니다(연속 스크롤 보기는 없습니다). 모든 처리는 브라우저 안에서 이루어지고 PDF 는 외부로 전송되지 않습니다.

## 열기와 쪽 이동

| 동작 | 방법 |
| --- | --- |
| 열기 | PDF 링크 또는 로컬 PDF 를 Chrome 에서 엽니다. 확장 아이콘으로 뷰어를 열 수도 있습니다 |
| 쪽 이동 | 도구 막대의 이전·다음 단추, 쪽 번호 입력란, 화면 양옆의 쪽 화살표 |

## 텍스트 선택·복사

- 글자 위를 끌어 선택하고 Ctrl+C 로 복사합니다. 복사되는 글자는 PDF 에서 추출한 텍스트입니다.
- 더블클릭·트리플클릭 선택과 Ctrl+A(모두 선택)를 지원합니다. 복사 순서는 읽기 순서입니다.

## 검색

- Ctrl+F 또는 도구 막대의 찾기 단추로 검색창을 엽니다. 문서 전체를 찾고 현재 쪽의 결과를 먼저 보여 줍니다.
- Enter 다음 결과, Shift+Enter 이전 결과, Esc 닫기. "대소문자 구분" 선택 상자가 있습니다.
- 결과 수와 위치가 화면에 표시됩니다.

## 문단 편집

1. 편집할 문단을 더블클릭합니다. 편집할 수 없는 문단이면 이유가 표시됩니다([limits.md](limits.md)).
2. 글자를 고칩니다. 화살표·Home/End·Shift 선택·Ctrl+A·Backspace/Delete·Enter 와 한글 입력(IME 조합)을 지원합니다. 편집기가 열리는 동안 친 글자는 열린 뒤 커서 위치에 들어갑니다.
3. 문단 상자의 핸들로 편집 영역 크기를 조절할 수 있습니다.
4. Esc 또는 바깥 클릭으로 편집을 확정합니다. 바뀐 것이 없으면 취소로 처리됩니다. 도구 막대의 "편집 취소"는 이번 편집을 버리고 원래대로 되돌립니다.

편집 규칙:

- 글자를 줄이거나 늘리면 문단은 편집 영역 안에서 다시 배치됩니다. 내용이 영역 아래를 넘으면 영역 아래 변이 필요한 만큼 자동으로 내려갑니다(허용된 상한까지). 글자 크기는 줄이지 않습니다.
- 상한에 막혀 넘치면 "초과" 표시와 경고가 나옵니다. "되돌리기"로 이번 편집을 버리거나 경고 상태로 확정할 수 있습니다.
- 원본 글꼴에 없는 글자(예: 원본 서브셋에 빠진 한글)는 번들된 대체 글꼴(Noto Sans KR 서브셋)로 씁니다. "폴백 글꼴 표시"를 켜면 그런 글자에 점선 밑줄이 보입니다. 굵게·기울임은 합성으로 표현하며 표시됩니다.
- 태그된 PDF 는 편집은 되지만 구조(읽기 순서·태그)는 갱신되지 않습니다. 시작할 때 안내가 나옵니다.

## 표 셀 편집

- 표 안의 셀을 더블클릭하면 셀 하나가 편집 단위로 열립니다. 이후 방법은 문단 편집과 같습니다.
- 셀 안에서 넘치면 셀 경계가 상한입니다. 표 행 높이는 바뀌지 않으며, 행·열 추가나 병합·분할은 지원하지 않습니다.
- 편집할 수 없는 셀에는 "이 셀은 편집할 수 없습니다"가 표시됩니다.

## 벡터 패스(도형·선) 편집

1. 패스를 Alt+클릭으로 선택합니다. "레이아웃·편집 표시"를 켜 두었다면 단순 클릭으로도 선택됩니다. Shift+클릭은 다중 선택(추가·제외)입니다. 겹쳐 있으면 가장 작은 패스가 선택됩니다.
2. 선택 상자를 끌어 이동하고, 8개 핸들로 크기를 바꿉니다(Shift 를 누르면 비율 고정).
3. "점 편집"을 켜면 꼭짓점·제어점을 하나씩 끌 수 있습니다(패스 하나만, 점 추가·삭제와 선분 종류 변경은 없음).
4. 속성 패널에서 채움 색·선 색·선 두께를 바꿉니다. 색 선택기는 닫을 때 한 번 반영됩니다.
5. Delete 키 또는 삭제 단추로 선택한 패스를 지웁니다(다중 선택 포함).
6. Esc 는 끄는 중이면 동작 취소, 다음은 점 편집 종료, 다음은 선택 해제입니다.

색 공간이 바뀌거나(예: 회색 → RGB) 클립 때문에 일부가 잘리는 경우, 표 괘선을 지우는 경우에는 경고가 표시됩니다.

## 되돌리기·다시 실행

| 동작 | 단축키 |
| --- | --- |
| 편집 되돌리기 | Ctrl+Z |
| 다시 실행 | Ctrl+Shift+Z, Ctrl+Y |

- 문단·셀·패스 편집 하나가 되돌리기 단위 하나입니다. 편집기 안에서는 글자 단위 이력이 따로 있습니다.
- 저장 직후 첫 되돌리기나 오류 복구 뒤에는 다시 실행·되돌리기 이력이 사라질 수 있습니다([limits.md](limits.md)).

## 레이아웃·편집 표시

도구 막대의 "레이아웃·편집 표시"를 켜면 쪽 위에 두 가지가 함께 그려집니다. 다시 누르면 둘 다 꺼집니다.

- 편집 가능 테두리: 문단·셀·패스마다 편집할 수 있는지(아래 표)
- 레이아웃: 문단·표·도형·읽기 순서(색 = 역할, 번호 = 읽기 순서). 함께 켜질 때 레이아웃은 얇은 테두리로 그려집니다.

레이아웃을 쓸 수 없는 쪽에서는 편집 가능 테두리만 켜지고, 버튼 툴팁에 사유가 나옵니다.

| 표시 | 뜻 |
| --- | --- |
| 초록 실선 | 편집할 수 있음 |
| 주황 점선 | 편집 제한(마우스를 올리면 사유가 툴팁으로 나옵니다) |

너무 작은 패스는 표시에서 빠지고, 한 쪽에 2,000개가 넘으면 면적이 큰 순서로 2,000개만 표시됩니다. 켜 둔 채로도 글자 선택과 더블클릭 편집은 그대로 동작합니다. 편집 중에는 표시가 숨겨집니다.

## 저장

- 도구 막대의 프린터 아이콘을 누르면 저장 메뉴가 열립니다: "저장"(Ctrl+S), "다른 이름으로 저장". 키보드로는 아이콘에서 Enter·↓ 로 열고 ↑↓·Enter 로 고르며 Esc 로 닫습니다.
- Ctrl+S 로 바로 저장합니다. 처음 저장할 때 저장 위치를 직접 고르며(파일 선택 창), 이후 같은 문서에서는 같은 파일에 다시 저장합니다.
- 파일 선택 창을 쓸 수 없는 환경에서는 다운로드로 저장됩니다.
- 열린 편집이 있으면 먼저 확정한 뒤 저장합니다.
- 저장 전에 경고가 있으면 확인 창이 나옵니다: 메모리를 많이 쓸 것으로 예상, 태그 구조 연결 끊김, PDF/A 적합성 훼손 가능성 등.
- 저장하면 편집한 쪽 번호가 파일 정보(`PdfEditorEdits`)에 기록됩니다.
- 편집한 문서는 항상 전체 저장을 하므로 원문이 파일에 남지 않습니다. 저장 시간·메모리는 문서 크기에 따라 늘어납니다([limits.md](limits.md)).
- 저장 위치는 사용자가 고른 파일입니다.

## 그 밖의 표시

| 항목 | 내용 |
| --- | --- |
| Redact(가림) 주석 | 문서에 적용되지 않은 Redact 주석이 있으면 열 때 개수와 쪽이 안내됩니다. 이 뷰어는 적용하지 않으며 저장 뒤에도 표시로 남습니다 |
| 레이아웃 오버레이 | 문단·표·도형·읽기 순서를 보여 주는 보조 화면(도구 막대 "레이아웃·편집 표시") |
| 진단 | 개발 빌드에서 가로채기 방식 등 진단 정보를 볼 수 있습니다 |

## English summary

- Open any PDF in Chrome; pages are shown one at a time. Select and copy text, search with Ctrl+F.
- Double-click a paragraph or table cell to edit it (IME input supported); Esc or clicking outside commits. Text reflows inside the edit area and the area grows downward up to a limit; glyphs missing from the original font use a bundled Noto Sans KR subset.
- Select vector paths with Alt+click (or plain click when "Layout & editable marks" is on), then move, resize, edit points, change fill/stroke color and width, or delete.
- Undo with Ctrl+Z, redo with Ctrl+Shift+Z / Ctrl+Y. Undo/redo history can be lost after a save or after crash recovery.
- The "Layout & editable marks" button turns on both the editable outlines (green = editable, orange dashed = restricted, with reason) and the layout overlay (paragraphs, tables, figures, reading order).
- The printer icon opens the save menu (Save, Save as). Ctrl+S saves directly; the first save asks for a target file, later saves reuse it. Edited documents are always fully rewritten.
