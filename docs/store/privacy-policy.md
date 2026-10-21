# 개인정보 처리 방침 (Privacy Policy)

시행일: 2026-10-21 (초안, 시행일은 제출 시 확정)
대상: Chrome 확장 프로그램 "PDF Editor"(가칭, 이하 "확장")
제공자: Juunary (https://github.com/Juunary/pdf-editor)

## 1. 수집하는 정보

없음. 확장은 개인정보와 사용 정보를 수집·저장·전송하지 않습니다. 계정, 서버, 분석 도구, 광고, 원격 측정 코드가 없습니다.

## 2. 처리 방식

- PDF 문서는 사용자의 브라우저 안에서만 처리됩니다(WebAssembly 로 실행되는 PDF 엔진). 문서 내용은 어떤 서버로도 전송되지 않습니다.
- 확장이 하는 네트워크 요청은 사용자가 열려는 PDF 자체를 읽는 것뿐입니다(브라우저가 넘겨준 PDF 스트림). 그 외 외부 서버 요청은 없습니다.
- 편집한 PDF 는 사용자가 고른 위치의 파일로만 저장됩니다. 파일 선택 창을 쓸 수 없을 때는 다운로드 폴더에 저장됩니다.

## 3. 브라우저에 남는 정보

| 정보 | 위치 | 설명 |
| --- | --- | --- |
| 편집 중인 문서·되돌리기 이력 | 탭 메모리 | 탭을 닫으면 사라집니다 |
| 설정(예: 태그 PDF 편집 막기) | 브라우저 로컬 저장소 | 이 기기 안에만 있고 전송되지 않습니다 |

저장한 PDF 의 파일 정보에는 편집한 쪽 번호가 `PdfEditorEdits` 항목으로 기록됩니다. 이 파일은 사용자가 보관·공유를 결정합니다.

## 4. 제3자 제공

없음. 판매·공유·광고 목적 사용이 없습니다.

## 5. 권한

확장이 요청하는 권한과 용도는 [practices.md](practices.md) 에 있습니다. 호스트 권한은 요청하지 않습니다.

## 6. 변경

방침이 바뀌면 이 문서를 갱신하고 시행일을 고칩니다. 변경 이력은 저장소 커밋 기록에 남습니다.

## 7. 문의

저장소 이슈: https://github.com/Juunary/pdf-editor/issues

## Summary (English)

PDF Editor collects no personal or usage data. PDFs are processed locally in your browser with WebAssembly and are never uploaded. The only network request is reading the PDF stream you opened. Edited PDFs are saved only to the file you choose (or your Downloads folder as a fallback). There are no accounts, servers, analytics, ads or third-party sharing. Contact: https://github.com/Juunary/pdf-editor/issues
