# 개인정보 관행 답변 초안(Web Store 개발자 대시보드)

기준 빌드: Web Store 빌드(D7 (a)). 최소 Chrome 151, `mime_types_handler` 로 PDF 를 열고 DNR·호스트 권한·`<all_urls>` 접근 가능 리소스는 없음. 아래 권한 목록은 제출 직전에 Web Store 빌드의 `manifest.json` 과 대조합니다(S3 산출물 `docs/m5-release.md`).

## 단일 목적

> 브라우저에서 PDF 문서를 열어 보고, 텍스트를 선택·검색하고, 문단·표 셀·벡터 도형을 편집해 사용자가 지정한 파일로 저장한다.

모든 기능이 "PDF 를 열어 편집하고 저장한다"는 한 목적에 속합니다.

## 권한별 정당화

| 권한·항목 | 용도 | 정당화 문구(영어, 대시보드 입력용) |
| --- | --- | --- |
| `mime_types_handler` (`application/pdf`, `can_embed`) | PDF 응답을 이 뷰어로 연다 | Registers the extension's viewer as the handler for `application/pdf` so PDFs the user opens in Chrome are displayed and edited in the viewer. The browser hands the PDF stream to the viewer; the extension does not request the PDF URL itself. |
| `downloads` | 파일 선택 창을 쓸 수 없을 때 저장 | Used only as a fallback to save the edited PDF to the user's Downloads folder when the File System Access save dialog is unavailable. No download history is read. |
| `content_security_policy` 의 `'wasm-unsafe-eval'` | PDF 엔진(MuPDF)을 WebAssembly 로 실행 | Required to instantiate the bundled MuPDF WebAssembly module. All code is packaged in the extension. |
| 호스트 권한 | 요청하지 않음 | No host permissions are requested. |

참고: 이 빌드에 포함되지 않는 개발·레거시 빌드 전용 권한(`declarativeNetRequestWithHostAccess`, `<all_urls>`)은 Web Store 제출 대상이 아닙니다. 128–150 폴백 경로를 Web Store 빌드에 되살리기로 바뀌면(D7 (b)) 이 표에 두 항목을 더해야 합니다.

## 원격 코드 사용 여부

답변: **원격 코드를 사용하지 않습니다(No)**.

- 모든 JavaScript·WebAssembly(MuPDF, harfbuzz 셰이퍼)·글꼴(Noto Sans KR 서브셋)은 확장 패키지에 번들됩니다.
- 외부 스크립트·`eval` 대체물 로드, 원격 설정에 의한 동작 변경이 없습니다.
- `'wasm-unsafe-eval'` 은 번들된 WASM 을 인스턴스화하기 위한 CSP 항목입니다.

## 데이터 사용 인증

수집 데이터 항목(개인 식별 정보, 건강, 금융, 인증 정보, 개인 통신, 위치, 웹 기록, 사용자 활동, 웹사이트 콘텐츠)은 모두 **수집하지 않음**으로 답합니다.

| 항목 | 답 | 근거 |
| --- | --- | --- |
| 웹사이트 콘텐츠 | 수집·전송하지 않음 | PDF 는 브라우저 안에서만 처리되고 외부로 전송되지 않는다 |
| 사용자 활동 | 수집하지 않음 | 분석·원격 측정 코드 없음 |
| 그 밖의 항목 | 수집하지 않음 | 서버·계정 없음 |

인증 항목(세 가지)에 모두 동의 가능한 상태입니다.

| 인증 | 상태 |
| --- | --- |
| 승인된 용도 외에 사용자 데이터를 판매·전송하지 않음 | 해당 데이터 없음 |
| 단일 목적과 무관한 목적으로 사용·전송하지 않음 | 해당 데이터 없음 |
| 신용도 판단·대출 목적으로 사용·전송하지 않음 | 해당 데이터 없음 |

개인정보 처리 방침 URL: [privacy-policy.md](privacy-policy.md) 의 저장소 공개 링크(`https://github.com/Juunary/pdf-editor/blob/main/docs/store/privacy-policy.md`, 병합 뒤 유효).

## 사용자 확인 필요

- 제출 직전 Web Store 빌드 매니페스트의 `permissions`·`host_permissions`·`web_accessible_resources` 가 위 표와 일치하는지.
- 네트워크 요청 유무 최종 확인: 뷰어가 PDF 스트림 외 요청을 하지 않는지(번들 자원 제외).
