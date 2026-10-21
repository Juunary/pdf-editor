# 설치

## 요구 사항

| 항목 | 내용 |
| --- | --- |
| 브라우저 | Chrome 151 이상(Web Store 판). 가로채기에 Chrome 의 MIME handler 기능을 씁니다 |
| 운영체제 | Windows 에서 확인했습니다(Chrome 155, `docs/m0-day1-log.md` 9절). 서버 Linux Chromium 으로 자동 시험을 합니다 |
| 개발·레거시 빌드 | Chrome 128–150 에서는 다른 가로채기 경로(DNR)를 쓰는 개발 빌드만 동작합니다. 이 경로는 제한이 있습니다([troubleshooting.md](troubleshooting.md)) |

## A. Chrome Web Store 에서 설치

1. Web Store 의 확장 프로그램 페이지에서 "Chrome 에 추가"를 누릅니다.
2. 설치 뒤 웹의 PDF 링크나 로컬 PDF 를 열면 이 확장의 뷰어로 열립니다.

Web Store 등록은 사용자가 제출합니다. 등록 전에는 B 방법을 씁니다.

## B. 압축해제된 확장 프로그램으로 설치(개발자 모드)

1. 저장소를 받아 빌드합니다(Node 22.13 이상).

   ```bash
   corepack enable pnpm
   pnpm install
   pnpm build
   ```

   결과는 `apps/extension/dist` 입니다. 미리 빌드한 폴더를 받았다면 이 단계는 건너뜁니다.

2. Chrome 주소창에 `chrome://extensions` 를 엽니다.
3. 오른쪽 위 "개발자 모드"를 켭니다.
4. "압축해제된 확장 프로그램을 로드합니다"를 누르고 `dist` 폴더를 고릅니다.
5. 목록에 확장이 나타나고 오류가 없으면 설치된 것입니다.

### 개발자 모드를 끄면 비활성화됩니다

압축해제 확장은 개발자 모드가 꺼지면 Chrome 이 비활성화하거나 시작 때 "개발자 모드 확장 프로그램을 사용 중지하시겠습니까?" 경고를 냅니다. 확장을 계속 쓰려면 개발자 모드를 켜 두어야 합니다. Web Store 판에는 해당하지 않습니다.

### 폴더를 옮기거나 지우지 않습니다

로드한 `dist` 폴더가 확장의 실제 위치입니다. 폴더를 옮기거나 지우면 확장이 오류 상태가 되고, 새 위치로 다시 로드해야 합니다.

## 파일 URL(로컬 PDF) 접근

| 가로채기 경로 | `file://` 설정 |
| --- | --- |
| Chrome 151 이상(MIME handler) | 별도 설정 없이 로컬 PDF 가 열립니다 |
| Chrome 128–150 개발·레거시 빌드(DNR) | `chrome://extensions` 에서 이 확장의 "세부정보" → "파일 URL에 대한 액세스 허용"을 켜야 합니다. 꺼져 있으면 로컬 PDF 는 Chrome 기본 뷰어로 열리고, 뷰어에서 안내 문구가 나옵니다 |

## 동작 확인

1. PDF 링크나 로컬 PDF 를 엽니다. 확장 뷰어(위쪽 도구 막대와 쪽 이동 단추)가 보이면 정상입니다.
2. 확장 아이콘을 눌러 뷰어를 직접 열 수도 있습니다.
3. 뷰어에 보이는 진단 정보의 `interceptionMode` 값이 `mime-handler` 이면 Chrome 151 이상 경로입니다.

## 업데이트

| 설치 방법 | 방법 |
| --- | --- |
| Web Store | Chrome 이 자동으로 갱신합니다 |
| 압축해제 | 새 `dist` 로 교체한 뒤 `chrome://extensions` 에서 확장의 새로고침 단추를 누릅니다 |

## 제거

`chrome://extensions` 에서 확장의 "삭제"를 누릅니다. 이 확장은 파일을 저장소 밖에 남기지 않습니다. 편집한 PDF 는 사용자가 지정한 위치에만 있습니다.

## English summary

- Requires Chrome 151 or later (Web Store build). Chrome 128–150 works only with the development/legacy build that uses a different, limited interception path (DNR).
- Unpacked install: build with `pnpm build`, open `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and select `apps/extension/dist`. Chrome disables unpacked extensions when Developer mode is turned off; keep it on.
- Local `file://` PDFs open without extra settings on Chrome 151+. On the legacy path, turn on "Allow access to file URLs" for the extension.
- Update unpacked installs by replacing `dist` and reloading the extension.
