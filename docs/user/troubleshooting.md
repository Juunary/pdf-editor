# 문제 해결

## PDF 가 이 뷰어로 열리지 않고 Chrome 기본 뷰어로 열립니다

| 원인 | 확인·조치 |
| --- | --- |
| 다른 PDF 확장이 나중에 설치됨 | PDF 를 여는 확장은 하나만 가로챌 수 있습니다. 나중에 설치한 PDF 확장이 있으면 그쪽이 PDF 를 엽니다. `chrome://extensions` 에서 다른 PDF 뷰어 확장을 끄거나 삭제한 뒤 PDF 를 다시 엽니다. |
| Chrome 버전이 낮음 | Chrome 151 미만에서는 Web Store 판이 PDF 를 가로채지 못합니다. `chrome://settings/help` 에서 Chrome 을 업데이트합니다 |
| 확장이 꺼져 있음 | `chrome://extensions` 에서 켭니다. 압축해제 설치는 개발자 모드가 꺼지면 비활성화됩니다([install.md](install.md)) |
| 지원하지 않는 응답 | POST 로 만든 PDF, 첨부 파일로 내려받는 응답(`content-disposition: attachment`)은 가로채지 않습니다(레거시 경로). 뷰어가 PDF 로 판단하지 못한 문서는 기본 뷰어로 되돌립니다 |
| 로컬 파일(레거시 경로) | Chrome 128–150 개발·레거시 빌드에서는 확장 세부정보의 "파일 URL에 대한 액세스 허용"이 필요합니다 |

## Chrome 151 미만

- Web Store 판은 Chrome 151 이상을 요구합니다. 그 아래 버전에는 설치할 수 없거나 가로채기가 동작하지 않습니다.
- Chrome 128–150 에서는 개발·레거시 빌드(DNR 경로)만 동작합니다. 이 경로의 제한: 뷰어가 원 URL 을 다시 받고(요청 2회), POST·첨부 응답은 가로채지 않으며, Chrome 150 은 공식 문서상 MIME handler 지원 전이라 이 경로에 포함됩니다.
- Chrome 128 미만은 지원하지 않습니다.

## 저장이 되지 않습니다

| 증상 | 조치 |
| --- | --- |
| "저장할 수 없습니다" 창 | 예상 메모리가 한계를 넘는 큰 문서입니다([limits.md](limits.md)). 저장하지 않은 편집은 파일을 다시 열면 사라집니다. 문서를 다시 연 뒤 편집을 나누어 저장하십시오 |
| "저장 전 확인" 창 | 경고를 읽고 계속할지 정합니다. 취소하면 저장하지 않습니다. 버튼이 "그래도 저장 시도" 이면 예상이 이미 커진 작업 메모리 때문이라 실제로는 저장될 수 있습니다. 실패하면 문서를 복구하고 다시 저장할지 묻습니다 |
| "저장 중 작업 모듈이 중단되어 문서를 복구했습니다" | 편집 내용은 복구되었습니다. 되돌리기 이력은 사라집니다. 안내에 따라 다시 저장합니다 |
| 파일 선택 창이 뜨지 않음 | 환경에 따라 다운로드로 저장됩니다. 다운로드 폴더를 확인하십시오 |
| 덮어쓰기 권한 | 같은 문서를 다시 저장할 때 Chrome 이 쓰기 권한을 다시 묻는 경우 허용해야 합니다 |

## 편집이 되지 않습니다

- 더블클릭해도 편집기가 열리지 않으면 사유가 표시됩니다. "레이아웃·편집 표시"를 켜 보면 쪽 전체의 편집 가능 여부를 한눈에 볼 수 있습니다([limits.md](limits.md)).
- 스캔 문서(이미지 속 글자)는 편집할 수 없습니다.
- 패스를 Alt+클릭해도 선택되지 않으면 문서를 연 직후일 수 있습니다. 잠시 뒤 다시 클릭하십시오.

## 한글 입력

- 편집기가 열리는 동안 친 글자는 열린 뒤 들어갑니다. 조합 중인 글자는 확정된 뒤 들어갑니다.
- 한글 입력기(IME) 실제 입력은 Windows Chrome 에서 사용자 확인 항목입니다(`docs/m3-integration.md` 7절).

## 문제 보고

저장소 이슈(github.com/Juunary/pdf-editor)에 Chrome 버전, 운영체제, 열려던 PDF 의 종류(웹 URL·로컬 파일·첨부), 뷰어 진단 정보의 `interceptionMode` 값을 적어 주십시오. PDF 파일 자체는 올리지 마십시오.

## English summary

- If PDFs open in Chrome's built-in viewer: another PDF extension installed later takes over interception; disable or remove it, or reinstall this extension. Check that the extension is enabled (unpacked installs are disabled when Developer mode is off).
- Chrome older than 151 is not supported by the Web Store build; Chrome 128–150 works only with the development/legacy (DNR) build, which does not intercept POST responses or attachments and needs "Allow access to file URLs" for local files.
- Save problems: a "cannot save" dialog means the estimated memory exceeds the limit; after crash recovery edits are restored but undo history is lost.
- Report issues with Chrome version, OS, PDF source type and the `interceptionMode` diagnostic value; do not attach the PDF.
