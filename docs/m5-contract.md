# M5 계약: 안정화·성능 기준·저장 힙 모델·배포 준비·문서화

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-21 |
| 범위 | PLAN.md 6절 M5(안정화/배포) 병렬 구현의 공통 기준 |
| 기준 | `m5` 브랜치 계약 커밋(이 문서, shared-types 추가분, `fflate` 개발 의존성). 모든 M5 작업은 이 커밋에서 시작한다 |
| 변경 권한 | `packages/shared-types`, 루트 설정, `pnpm-lock.yaml`, `apps/extension/public/manifest.json` 의 권한·이름·버전, 새 의존성, `fixtures/bench/manifest.json` 의 대용량 문서 항목(8절)은 메인 세션만 바꾼다 |
| 일정 | PLAN.md 6절 계획은 3주(2027-02-08~02-28). 2026-10-21 착수 |
| 상태 표기 | 확정·권고·결정 대기 |
| 독립 검토 반영 | 2026-10-21 독립 검토 지적 H1–H9·M1–M8·L1–L5 반영(변경 이력 참조). 결정 대기 D1·D2·D3·D7 |
| 변경 이력 | 2026-10-21 초안. 2026-10-21 독립 검토 반영: 메모리 기준점·탭 메모리 정의(H1·H2), 모델 입력을 원 스트림 /Length 로 변경·유휴 계산(H3), 예상 피크 식에 현재 힙·저널 반영(H4), 미탐·과탐·검증 방법 정의(H5), 고지 생성 방식(H6), 릴리스 스테이징·스모크(H7), 파일 담당 정정·C6 범위 밖(H8), 3절 타입 추가(H9), D7 신설(M1), 버전 범위 문구(M2), AGPL 소스 링크·태그(M3), 등록 자료(M4), 기준 PC 판정·회귀 표시(M5), 지표 이벤트 이름(M6), 8절 대용량 문서 확보 기준 신설(M7), Chrome Worker 검증(M8), L1–L5 수정 1(2026-10-21, 사용자 결정): D1·D2·D3·D7 권고안 확정. 100 MB 이상 실제 문서는 후보 확인 전까지 합성 대체(8절)로 시작 |

## 1. 완료 기준과 범위

### 1.1 M5 완료 기준(DoD)

| 축 | 기준 | 측정 |
| --- | --- | --- |
| 성능 기준 | 벤치마크 문서 세트·기준 PC·목표 수치를 고정하고(D1), **Windows 기준 PC 에서 목표를 충족**한다. 서버는 같은 하네스로 기록하고 직전 기록 대비 +20% 를 넘는 지표를 회귀로 표시한다(판정 아님, 원인 기록 대상) | 벤치마크 하네스(4.1) |
| Windows 실행 | 압축해제 로드한 `dist` 의 측정 페이지에서 사용자가 수동 실행하고 결과 JSON 을 회신한다. pnpm·Node 설치 불필요 | 4.1 |
| 저장 힙 | 4.2 의 정의로 미탐 0건, 과탐 10% 이하. 코퍼스·합성(이미지 위주·객체 위주)·대용량 문서 포함 | 4.2 |
| 대용량 | 100 MB 이상 실제 문서(8절 기준, 없으면 합성 대체)에서 열기·렌더·편집·저장 또는 저장 전 중단 안내가 동작한다. 상한을 넘으면 안내(PLAN.md 7절 리스크 8). Chrome Worker 에서 1회 이상 확인하고, 탭 크래시는 미탐으로 센다 | 4.2·4.1 |
| 메모리 | 기준점 = 첫 저장 완료 직후. 이후 50쪽 넘김 왕복·편집 20회·저장 2회 뒤 추가 WASM 힙 증가 ≤ 64 MiB(누수 감시), 탭 메모리 증가 ≤ 150 MiB(정의 4.1). 첫 저장 피크 WASM 힙은 D5 예측 이내 | 4.1 |
| 배포 | 매니페스트·아이콘·라이선스 고지·개발용 파일 제외·버전·zip·크기 검사·릴리스 스테이징 스모크(D6)가 갖춰져 Chrome Web Store 업로드 가능 상태. 사용자가 개발자 대시보드에 초안 업로드 시 오류 없음(사용자 확인, 실제 제출은 D2) | 4.3 |
| 문서 | 사용자 설치·사용 안내, 지원 범위·제한, 문제 해결, 개인정보 처리 방침(공개 URL), 등록 자료, 저장소 README·아키텍처·기여 안내, 릴리스 절차 | 4.4 |
| 정리 | 1.2 이관 항목 처리 | 항목별 |
| 회귀 | 전체 강제 검증, 코퍼스 편집 측정(M3·M4 하네스) 회귀 없음 | 기존 하네스 |

### 1.2 이관 항목(M5 에서 처리)

| 항목 | 출처 | 처리 |
| --- | --- | --- |
| A3-5·A3-8·A7-5 저장 힙 모델 재산정·검증 | `docs/m0-dod-xobject-redact-save.md` 3.6, `docs/m0-corpus-recheck.md` 8절 | S1 |
| A3-4 Windows Worker 피크·탭 메모리 반복 측정 | 같은 문서 | S2(하네스)·사용자(측정) |
| A3(Day 1) 벤치마크 문서 세트·PC 조건 | `docs/m0-day1-log.md` 8절 | D1·S2 |
| A7-10 코퍼스 보강(100 MB 이상, 이미지 위주·객체 위주) | 코퍼스 8절 | 메인 세션이 착수 전 선정·다운로드 스크립트 확정(8절) → S1 에 전달 |
| A7-10 코퍼스 보강(한국어 수백 쪽, 기존 Redact 주석, 표 셀) | 코퍼스 8절 | 메인 세션이 8절 라이선스 기준으로 선정 → S2 가 벤치 세트 등록 |
| A8 폴백 폰트 배포 크기 | Day 1 8절 | 4.3(크기 측정·기록, 축소 안 함: M3 D12 결정 유지) |
| 리스크 8 지원 문서 크기 상한 안내 UI | PLAN.md 7절 | S1(core 값)·S3(UI) |
| 렌더 캐시 LRU(PLAN.md 5.4) | PLAN.md 5.4 | S2 |
| 쪽 판정 시간(최대 패스 쪽 1.75 s) | `docs/m4-integration.md` 6절 #4 | S2 |
| 저널 단계 수 상한, 체크포인트 필요 여부 | `docs/m3-core.md` 4절 #5·#8 | S1(측정 근거 제시)·D4 |
| redo·undo 소실 안내 문구(저장 뒤·복구 뒤) | `docs/m3-integration.md` 7절 #4 | S3 |
| M4 리뷰 후속 LOW 6건(L2–L5·L7·L8) | `docs/m4-integration.md` 8.1 | L4(`open.ts` 주석) S1, 나머지 S5(L8 은 core `edit-engine.ts` 경고 부분 포함) |
| M4 남은 제한 중 첫 Alt+클릭 소실 | `docs/m4-integration.md` 7절 | S5 |
| MuPDF WASM "memory access out of bounds" 간헐 중단 감시 | `docs/m1-decisions.md` 86행, `docs/m1-core.md` M1 | S2: 코퍼스 열기·추출·저장 반복 퍼징 N회(권고 200회) 실행·발생 횟수 기록. 0회가 아니면 재현 정보 보존 후 메인 세션 보고 |
| 편집 반응 목표 p95 100 ms 고정 | `docs/m3-integration.md` 6절 | D1 |
| README 갱신(M0 시기 내용) | 저장소 | S4 |
| 사용자 설치 안내(개발자 모드 꺼짐 시 비활성화, C11) | 코퍼스 7절 | S4 |

### 1.3 범위 밖(M5)

- 연속 스크롤 다쪽 보기(D3 결정 대기), 새 편집 기능.
- 같은 텍스트 bbox 초과 잔여 2/110(C6·C7, `docs/m3-integration.md` 10절). 근거: `packages/pdf-ops/src/paragraph-edit.ts`·`edit-plan.ts` 를 고쳐야 하며 안정화 범위의 담당 파일 분할과 겹친다. 후속 마일스톤 후보로 기록.
- ML 옵트인(PLAN.md 2절 ML 행, 필요 근거 없음).
- Tauri 데스크톱(후속).
- 글자쌍 커닝 보존(M4 남은 제한, 후속).
- 사용자 확인 항목 자체(Windows·Acrobat·라벨 사람 확인)는 사용자가 하고, 이 계약은 확인 절차와 기록 자리만 둔다.

## 2. 결정 사항

| # | 주제 | 상태 |
| --- | --- | --- |
| D1 | 벤치마크 문서 세트·기준 PC·목표 수치 | **확정**(사용자 결정 2026-10-21, 권고안) |
| D2 | Web Store 제출 범위 | **확정**(사용자 결정 2026-10-21, 권고안): 업로드 가능 패키지·등록 자료 초안까지, 계정·제출·심사는 사용자 |
| D3 | 연속 스크롤 다쪽 보기 | **확정**(사용자 결정 2026-10-21, 권고안): 범위 밖 |
| D4 | 저널 단계 상한·체크포인트 | 권고(측정 뒤 확정) |
| D5 | 저장 힙 모델 형태 | 권고 |
| D6 | 배포 패키지 구성 | 권고 |
| D7 | Web Store 빌드 최소 Chrome 버전·가로채기 경로 | **확정**(사용자 결정 2026-10-21, 권고안) (a): Web Store 빌드는 Chrome 151 이상, DNR·호스트 권한·`<all_urls>` WAR 제거. 128–150 DNR 경로는 개발·레거시 빌드에만 |

### D1 벤치마크 기준(권고)

- 기준 PC: 사용자 Windows PC(Intel Core Ultra 5 228V, RAM 31.5 GiB, Windows 11, Chrome 정식 최신)와 서버(Playwright 번들 Chromium, headless). 판정은 Windows 기준 PC, 서버는 회귀 감시용(직전 기록 대비 +20% 초과 시 회귀 표시).
- 문서 세트(고정, `fixtures/bench/manifest.json`): 코퍼스에서 nist-sp800-53r5(492쪽), nasa-se-handbook-sp2016-6105(297쪽), kogl-nabo-finstmt2025(179쪽, 한국어 표), zen-beamer-7535020(11.8 MB), arxiv-2609.09268(벡터 도표) + 8절 대용량 문서(이미지 위주 1건·객체 위주 1건) + 합성 900쪽(675.7 MiB, 저장 상한 시험용) + 합성 객체 위주(2,000쪽 텍스트, 객체 ≥ 500k).
- 목표(권고, Windows 기준 PC, p95). 각 지표는 시작·끝 이벤트(`performance.mark` 이름) 사이 시간으로 잰다:

| 지표 | 목표 | 시작 이벤트 | 끝 이벤트 |
| --- | --- | --- | --- |
| 열기(바이트 수신 → 첫 쪽 표시) | 500쪽 이하 문서 1.5 s | `m5:open:bytes-received` | `m5:open:first-page-shown` |
| 쪽 넘김(다음 쪽 표시) | 300 ms | `m5:nav:request` | `m5:nav:page-shown` |
| 편집 반응(입력 → 미리보기 합성) | 100 ms(M3 잠정 목표 고정) | `m5:edit:input` | `m5:edit:preview-composited` |
| 패스 끌기 갱신 | 150 ms | `m5:path:pointermove` | `m5:path:frame-painted` |
| 쪽 편집 가능 판정(첫 진입 포함) | 1.0 s(쪽 캐시 재사용 뒤 200 ms) | `m5:judge:page-enter` | `m5:judge:editability-ready` |
| 전체 저장 | 500쪽 이하 문서 3 s | `m5:save:start`(planSave 호출) | `m5:save:bytes-ready` |
| 메모리 | 1.1 메모리 시나리오: 추가 WASM 힙 증가 ≤ 64 MiB, 탭 메모리 증가 ≤ 150 MiB | `m5:mem:baseline`(첫 저장 완료) | `m5:mem:end` |

- 쪽 판정 1.0 s 대체안: 패스 쪽에서 1.0 s 를 못 맞추면 패스 판정을 첫 진입 뒤로 미루고(유휴·패스 편집 진입 시 계산), 첫 진입 목표는 문단 판정만 센다. 이때 `m5:judge:editability-ready` 는 문단 판정 완료 시점, 패스 판정 완료는 `m5:judge:paths-ready` 로 따로 기록한다.

### D2 Web Store 제출 범위(권고)

- M5 는 "업로드 가능한 패키지와 등록 자료 초안"까지 만든다. 개발자 계정 등록·결제·제출·심사 대응은 사용자가 한다.
- 이름 "PDF Editor"(가칭, 상표 검색은 사용자), 버전 1.0.0, 공개 범위는 사용자가 정한다(권고: 비공개 테스트 → 공개). 비공개 설치 뒤 사용자가 진단의 `interceptionMode` 가 `mimeHandler` 인지 확인한다.
- 지원 버전 문구: mimeHandler 경로는 Chrome 151 이상(공식 문서 기준). Chrome 128–150 은 DNR 폴백 경로(Chrome 150 은 CfT 에서 API 가 보이나 공식 문서상 미지원이라 폴백 범위에 넣는다). Web Store 빌드의 범위는 D7.
- 등록 자료(`docs/store/`, S4): 스크린샷 1280×800 1장 이상, 작은 프로모션 타일 440×280, 설명 132자 이하, 개인정보 관행 답변(단일 목적, 권한별 정당화, 원격 코드: 없음, 데이터 사용 인증), 개인정보 처리 방침 공개 URL(저장소 파일 링크), 매니페스트 `icons` 와 `action.default_icon`.
- 권한 정당화 문구는 D7 결과에 맞춘다. (a) 이면 `downloads`(FSA 불가 시 저장)와 `mime_types_handler` 설명만, (b) 이면 `<all_urls>` 호스트 권한(웹 PDF 가로채기·`embed`/`iframe` 대응)·`declarativeNetRequestWithHostAccess`(Chrome 128–150 폴백)를 더한다. 원격 코드 없음(MuPDF·harfbuzz 는 번들).

### D3 연속 스크롤 다쪽 보기(권고)

- M5 범위 밖으로 둔다(지금 한 쪽씩 보기·쪽 화살표). 근거: 편집 오버레이·텍스트 층·렌더 캐시가 모두 한 쪽 전제이고, 다쪽 보기는 새 기능이라 안정화 마일스톤과 맞지 않는다. 후속 마일스톤 후보로 기록.

### D4 저널 단계 상한·체크포인트

- 측정: 편집 1회당 저널 증가는 그 쪽 콘텐츠 크기 정도(`docs/m3-core.md` 2.5). S1 이 코퍼스 최대 쪽 기준 100·500회 편집 시 힙을 잰다.
- 저널 보유 추정: JS 에서 작업마다 교체한 스트림 길이를 더한다(WASM 조회 없음).
- 판정: 저널 보유 추정 + 예상 저장 증가분(D5) > 경고선이면 "저장 후 다시 열기" 권고 안내. 경고선은 저장 힙 판정의 warn 경계(`save-method.ts` `HEAP_WARN_FRACTION` × 상한)와 같게 두고, 값은 측정 뒤 확정.
- 체크포인트는 재적용 시간이 2 s 를 넘을 때만 도입.

### D5 저장 힙 모델

- 예상 피크 = max(현재 `wasmHeapBytes`, 기본 + 저널 보유 추정) + 저장 증가분.
  - 기본 = 문서 열기 완료 직후 측정한 WASM 힙.
  - 저장 증가분 = a × 입력 바이트 + b × 객체 수 + c × 원 스트림 바이트(/Length 합).
- 계수는 코퍼스·합성 측정에 최소 제곱 + 안전 여유(미탐 0 이 되도록 상향)로 정한다. 입력은 Stream 경로만 쓴다(운영 경로, Buffer 계수 없음).
- 모델 입력(객체 수·스트림 수·원 스트림 바이트)은 첫 쪽 표시 뒤 유휴 시 한 번 계산하고 열기 시간에 넣지 않는다. 방법: `countObjects()` 로 객체 수, 객체 번호마다 간접 참조에 직접 `isStream()` 확인 후 /Length 를 더한다. `resolve()`·디코드는 쓰지 않는다. 1 s 를 넘으면 고정 간격으로 객체 번호를 표본 추출해 비율로 환산하고 `approximate: true` 로 둔다.
- 측정 근거(독립 검토, 서버):

| 대상 | 계산 시간 | 비고 |
| --- | --- | --- |
| nist-sp800-53r5 | 46 ms | /Length 합, 디코드 없음 |
| nasa-se-handbook-sp2016-6105 | 16 ms | 같음 |
| 합성 227 MiB | 11 ms | 같음 |
| 디코드 합산 방식(비교) | 580 ms, WASM 힙 +73 MiB | 채택 안 함 |

### D6 배포 패키지

- `dist` 는 지금과 같다(진단 포함, 개발·e2e 용).
- `pnpm --filter @pdf-editor/extension package` 가 `dist` 에서 `diag/`·`*.map` 을 뺀 `out/release/staging/` 을 만들고, 그 내용으로 zip 을 `out/release/` 에 만든다. zip 은 `fflate`(개발 의존성 0.8.3)로 만들고 항목 시각·순서를 고정해 같은 입력이면 같은 바이트가 나오게 한다.
- 릴리스 빌드 소스맵은 `hidden`(번들에 `sourceMappingURL` 없음)이고, 맵 파일은 zip 에 넣지 않고 릴리스 자산으로 따로 보관한다.
- `verify-dist --release <dir>` 가 스테이징과 zip 을 검사한다: 개발 파일 부재(`diag/`·`*.map`·`sourceMappingURL`), 크기 상한(압축 전 합계 25 MiB, zip 15 MiB), 버전 일치, 아이콘·`LICENSE`·`THIRD_PARTY_NOTICES.txt`·저작권 고지 존재. Web Store zip 크기 제한 값은 미확인(상한은 자체 기준으로 유지).
- 버전 출처는 하나: `apps/extension/package.json` 의 `version` 을 빌드 시 매니페스트에 넣는다.
- 스모크 e2e: 스테이징을 압축해제 확장으로 로드하고 http 로 제공한 픽스처로 열기·렌더·저장을 확인한다.
- 진단 패널은 DOM 에 남기고 CSS·`<details>` 로 숨긴다. 벤치 버튼은 릴리스에서 숨긴다.
- 라이선스:
  - `THIRD_PARTY_NOTICES.txt` 는 번들 그래프에서 만든다. vite/rolldown 출력의 모듈 목록 → 각 패키지 `package.json` 의 `license` 와 `node_modules` 의 LICENSE·NOTICE 파일. 개발 의존성이 들어가지 않음을 시험으로 확인한다.
  - 번들 그래프에 안 보이는 것은 수동 표 `scripts/release/third-party-extra.json` 에 둔다: MuPDF WASM 에 정적 링크된 thirdparty 라이브러리(목록은 MuPDF 1.28.1 소스 `thirdparty/` 와 WASM 빌드 설정에서 확인해 확정)와 harfbuzz.
  - Noto Sans KR 부분집합의 `name` 표에 예약 글꼴 이름 'Source' 가 없는지 확인한다(OFL 예약 이름).
  - 뷰어 "정보" 대화상자: 버전·라이선스·소스 링크. AGPL 소스 링크는 버전 태그 `/tree/v<version>` 을 가리킨다.
- 아이콘 16·32·48·128 px(단순 도형, 상표 없음), 매니페스트 `icons` 와 `action.default_icon`.

### D7 Web Store 빌드 최소 Chrome 버전·가로채기 경로(결정 대기, 권고 (a))

- 위험: 지금 매니페스트는 `viewer.html` 을 `web_accessible_resources`(`<all_urls>`)로 열고 `host_permissions` 가 `<all_urls>` 다. 아무 웹 페이지나 `viewer.html?file=<url>` 을 iframe 으로 띄우면 뷰어가 확장 권한으로 그 URL 에 자격 증명 포함 GET 을 보낸다(사용자 쿠키로 다른 사이트 내용 요청).
- (a) 권고: Web Store 빌드는 `minimum_chrome_version` 151(공식 문서 기준 mimeHandler 지원), DNR 권한·규칙, `host_permissions`, `web_accessible_resources` `<all_urls>` 를 뺀다. 개발·레거시 빌드는 Chrome 128–150 DNR 경로를 유지하는 별도 빌드 종류로 둔다(S3 가 빌드 종류 구현, 매니페스트 권한 값은 메인 세션).
- (b) 대안: 128–150 을 Web Store 빌드에도 유지하고 보강한다. WAR `use_dynamic_url: true`, `chrome.mimeHandler` 가 있으면 `?file=` 무시, `location.ancestorOrigins` 확인으로 다른 출처 프레임 거부.

## 3. 타입

이 계약 커밋에서 `packages/shared-types` 에 더했다(모두 선택 필드, 기존 생성 코드 변경 없음).

- `OpenResult.documentStats?: DocumentStats`. `DocumentStats = { objectCount; streamCount; rawStreamBytes; approximate: boolean }`. 첫 쪽 표시 뒤 유휴 계산이라 열기 응답에서는 비어 있을 수 있다(S1 이 채우는 경로를 정함).
- `SaveHeapEstimate` 에 모델 입력 `objectCount?`·`rawStreamBytes?`·`journalBytes?`·`model?: string`(S1 이 채움).
- 그 밖의 shared-types 변경은 메인 세션 승인.

## 4. 작업 규칙

### 4.1 벤치마크·성능(S2)

- 하네스: 서버 Playwright(번들 Chromium)와 Windows 기준 PC 에서 같은 측정 페이지(확장 안 진단 기능, 결과 JSON 내보내기)를 쓴다. 측정 항목 = D1 표, 이벤트 이름 = D1 표.
- 탭 메모리 정의: Chrome 작업 관리자(Shift+Esc) "메모리 사용 공간" 의 뷰어 프레임 프로세스 값(임베디드는 확장 하위 프레임 행). Windows 는 사용자가 읽어 결과 JSON 의 수동 입력 필드에 넣는다. 서버는 렌더러 PID 의 `/proc/<pid>/status` `VmRSS`.
- 렌더 캐시: 쪽 렌더 결과(배율·쪽 기준) LRU, 상한은 8쪽과 64 MiB 중 작은 쪽, 문서 변경 시 해당 쪽 무효화. 다음 쪽 미리 렌더(유휴 시 1쪽).
- 쪽 판정 시간: 첫 진입 1.75 s 의 구성(추출·SourceMap·레이아웃·패스 판정)을 나눠 재고, 목표 넘는 구간을 줄인다. 1.0 s 를 못 맞추면 D1 대체안(패스 판정 지연).
- 메모리 시나리오 시험(서버): 1.1 메모리 기준(첫 저장 완료 기준점)으로 추가 WASM 힙 증가 상한을 시험으로 고정.
- MuPDF WASM OOB 간헐 감시(1.2).

### 4.2 저장 힙 모델(S1)

- D5 모델과 계수 산정 스크립트, 측정 데이터(코퍼스 24건 + 합성 100–900쪽 + 합성 객체 위주 + 8절 대용량 문서)와 결과 표.
- 미탐: 문서·저장 방식별로 측정 피크 > 예상 피크. 0건이어야 한다.
- 과탐: warn·over-limit 판정 중 측정 피크 < 상한 × 0.5 인 비율. 10% 이하.
- 검증: 문서 단위 leave-one-out(검증 문서를 빼고 적합한 계수로 그 문서를 예측). 대용량 문서는 적합에서 빼고 검증에만 쓴다.
- 대용량 문서 검증은 Node 측정과 별도로 Chrome Worker 에서 1회 이상 돈다. 탭 크래시는 미탐으로 센다.
- `decideSaveMethod`·`planSave` 를 새 모델로 바꾸고 이전 배율 모델과 비교(미탐·과탐).
- 지원 문서 크기 상한 안내: 예상 저장 피크가 상한을 넘으면 "편집·저장이 실패할 수 있음" 을 알리는 값(core)과 문구(S3).
- 저널 상한(D4) 측정·안내 값.

### 4.3 배포(S3)

- D6 전부, D7 결정에 따른 빌드 종류, 매니페스트 이름·설명·버전(메인 세션이 계약 커밋 뒤 승인), "정보" 대화상자, redo·undo 소실 안내 문구, 지원 크기 상한 안내 UI, 폰트·wasm 크기 기록(gzip·brotli 둘 다, brotli 는 Node `zlib.brotliCompressSync`).

### 4.4 문서(S4)

- `docs/user/`: 설치(개발자 모드·압축해제 로드·파일 URL 접근·업데이트), 사용법(열기·텍스트 선택·검색·문단·셀·패스 편집·되돌리기·저장), 지원 범위·제한(편집 제한 사유 목록을 사용자 말로), 문제 해결(나중에 설치한 다른 PDF 확장이 가로채기를 가져가는 경우 포함).
- `docs/store/`: 등록 설명 초안(한·영, 132자 이하 요약), D2 등록 자료 목록, 개인정보 처리 방침(수집 없음·로컬 처리·네트워크 요청은 PDF 원 URL 만, 저장소 파일 링크로 공개 URL 제공), 권한 정당화(D7 결과 반영).
- 저장소: README(개요·실행·구조·결과 표·한계, 사용자 README 규칙에 따라 고찰 없이), `docs/architecture.md`(패키지·데이터 흐름·계약 문서 색인), `CONTRIBUTING.md`, `docs/release.md`(버전·태그·패키지·검증 절차. 릴리스 태그 `v<version>` push 는 사용자 승인 단계).

### 4.5 정리(S5)

- M4 리뷰 후속 L2·L3·L5·L7·L8(L8 은 core `edit-engine.ts` 경고 부분 포함), 첫 Alt+클릭 소실 원인. L4(`open.ts` 주석)는 S1. C6·C7 은 범위 밖(1.3).

## 5. 작업 분할

| 작업 | 담당 모델 | 허용 파일 | 내용 |
| --- | --- | --- | --- |
| S1 저장 힙·저널 | Opus | `packages/pdf-ops/src/save-method.ts`·시험, `packages/core/src/open.ts`(전체, L4 주석 포함), `packages/core/src/session.ts`·`edit-engine.ts` 의 저장·통계 부분, `tools/bench/**`(새), `docs/m5-heap.md` | 4.2 |
| S2 성능 | Sonnet, 설계 판단 Opus | `packages/core/**`(S1·S5 부분 제외), `packages/viewer-ui/src/controller.ts`(렌더 캐시)·렌더 관련, 벤치 진입 연결(`apps/extension/vite.config.ts` 의 `input` 벤치 항목, `apps/extension/viewer.html` 의 벤치 버튼·훅), `apps/extension/src/viewer/bench*`(새), `apps/extension/e2e/bench*.spec.ts`, `fixtures/bench/**`(8절 대용량 항목 제외), `docs/m5-perf.md` | 4.1 |
| S3 배포·UI | Sonnet | `apps/extension/**`(S2 벤치 파일·벤치 진입 연결 부분 제외, 매니페스트 권한·이름·버전 값 제외), `packages/viewer-ui/src/components/**`(정보·안내 UI, `PathLayer.tsx` 제외), `packages/viewer-ui/src/mount.tsx`, `packages/viewer-ui/src/edit-controller.ts` 의 안내 훅, `scripts/release/**`, `docs/m5-release.md` | 4.3 |
| S4 문서 | Sonnet | `docs/user/**`, `docs/store/**`, `README.md`, `docs/architecture.md`, `CONTRIBUTING.md`, `docs/release.md` | 4.4 |
| S5 정리 | Sonnet | `packages/pdf-ops/src/path-edit.ts`, `packages/viewer-ui/src/path-*`·`components/PathLayer.tsx`, `packages/core/src/edit-engine.ts` 의 경고 부분(L8), `docs/m4-integration.md` 9절(새) | 4.5 |

- core 를 S1·S2·S5 가 함께 만지므로 S1 은 `open.ts`·저장·통계 함수만, S2 는 렌더 캐시·판정 시간만, S5 는 `edit-engine.ts` 경고 부분만 바꾼다. 겹치면 메인 세션에 보고.
- `apps/extension/vite.config.ts`·`viewer.html` 은 S2(벤치 진입)·S3(릴리스 빌드·소스맵·빌드 종류·진단 숨김)가 구역을 나눠 만진다. 머지 순서 S2 → S3 이므로 S3 가 충돌을 해소한다.
- `packages/viewer-ui/src/controller.ts` 의 렌더 캐시는 S2 소유, S3 는 `edit-controller.ts` 안내 훅과 `mount.tsx` 만.
- 공통 규칙은 M3 계약 6.2 와 같다(각자 worktree, 단계별 커밋, AI 공동 저자 표기 금지, push 금지, 완료 기준 강제 검증).

## 6. 통합 순서

0. 착수 전(메인 세션): 8절 대용량 문서 확정·`fixtures/bench/manifest.json` 대용량 항목·다운로드 스크립트 작성 → S1 에 전달. D7 결정 요청.
1. S1·S5 → S2 → S3 → S4 머지(메인 세션, 사용자 승인).
2. 통합: 벤치마크 서버 실행(직전 기록 대비 회귀 표시), 코퍼스 편집 회귀(M3·M4 하네스), 패키지 생성·`verify-dist --release`·스테이징 스모크 e2e.
3. 마일스톤 리뷰(읽기 전용) → 사용자 승인 후 main 병합.
4. 사용자 확인:
   - Windows 기준 PC: 압축해제 `dist` 측정 페이지 실행, 탭 메모리 수동 입력, 결과 JSON 회신.
   - 설치 안내대로 설치, M4 기능 확인.
   - U1 Acrobat Reader 표시·글꼴 속성·Redact 표시(설치된 경우, `docs/m0-closeout.md` 3절).
   - U4 정식 Chrome 128–149 DNR 경로(선택, D7 (a) 이면 개발·레거시 빌드 대상).
   - (선택) Web Store 대시보드 초안 업로드 오류 없음, 비공개 설치 뒤 진단 `interceptionMode` 확인.
   - 8절 대용량 문서 후보 출처·라이선스 사람 확인.

## 7. PLAN.md 반영(D1–D3·D7 확정 후)

- 5.1: 가로채기 경로 버전 문구(mimeHandler 151 이상, DNR 128–150), D7 결과(Web Store 빌드 범위·빌드 종류).
- 5.4: 렌더 캐시 구현(8쪽·64 MiB), 저장 힙 모델(D5), 지원 크기 상한 안내.
- 6절 M5 행: 1.1 요약, D1 목표.
- 7절 리스크 3·8: 대응 상태.
- 8절 성능 축: D1 기준(이벤트 이름·탭 메모리 정의 포함).
- 11절: 환경 점검 갱신(pnpm 설치됨, Windows 기준 PC 사양).
- 2절 폰트 행 크기 정정(4,082,236 B, 16,966 글리프).

## 8. 대용량 문서 확보 기준

| 항목 | 기준 |
| --- | --- |
| 결정 주체·시점 | 메인 세션이 S1 착수 전에 문서와 다운로드 스크립트를 확정해 S1 에 전달한다 |
| 라이선스 근거 | 미국 연방 정부 저작물(17 USC 105), 공공누리 제1유형, CC BY 중 하나. 근거 문구·URL 을 기록 |
| 저장소 | 문서 파일은 커밋하지 않는다. `fixtures/bench/manifest.json` 에 URL·SHA-256·바이트 수·라이선스 근거를 적고 스크립트로 받는다(해시 불일치 시 실패) |
| 구성 | 100 MB 이상 이미지 위주 1건, 객체 위주 1건. 실제 문서를 못 구하면 합성으로 대체 가능 |
| 합성 | 생성기 경로와 시드를 매니페스트에 기록해 같은 바이트를 재생성한다. 객체 위주 합성: 2,000쪽 텍스트, 객체 ≥ 500k |
| 확인 | 후보 출처·라이선스는 사람 확인 필요(사용자 확인 항목, 6절 4) |
