# M1 core: 추출 모델·검색·Stream 입력

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-19 |
| 범위 | `docs/m1-contract.md` 5.2절(`extractPage`·`searchText`·Stream 입력) |
| 브랜치 | `m1-core` (기준: 계약 커밋 97a6fb4) |
| 환경 | 서버 Node, mupdf 1.28.1 |

## 1. 상태

| 항목 | 상태 |
|---|---|
| V1 (Form 재귀 순서) | 확인됨 |
| V3 (글리프 정확히 한 번) | **불일치**: Tr 4·5·6 에서 계약 3절 "포인터 동일" 규칙이 글리프를 두 번 센다. 구현 중단, 계약 수정 대기 |
| `extractPage` | 미착수(V3 규칙 확정 후) |
| `searchText` | 미착수 |
| Stream 입력(A3-1) | 미착수 |

## 2. 검증 전제 확인 (2026-10-19, 서버 Node, 합성 PDF)

재현 코드: `packages/core/test/mupdf-text-callbacks.test.ts` (9건). 실행: `pnpm --filter @pdf-editor/core exec vitest run test/mupdf-text-callbacks.test.ts`.

### 2.1 V1: 확인됨

- `runPageContents` Device 콜백은 `Do` 위치에서 Form 안 텍스트를 콘텐츠 실행 순서로 보낸다. 관측 순서: `fillText(A)` → `clipPath` → `fillText(XY, Form 안)` → `popClip` → `fillText(Z)`.
- Form XObject 에 `/BBox` 가 있으면 `Do` 한 번이 `clipPath` 콜백 1개(+ `popClip`)를 만든다. 이 `clipPath` 는 계약 3절 paintSeq 규칙(clipPath 포함)에 따라 paintSeq 를 1 쓴다. pdf-ops 인터프리터가 Form `Do` 마다 BBox 클립 1개를 센다는 가정이 필요하다.

### 2.2 V3: 불일치

관측(문자열 "ABCD" 4글리프를 `BT … ET` 한 개로 표시, 콜백 종류와 텍스트 객체 포인터):

| Tr | 콜백 순서 | fill/stroke 와 clip 의 포인터 | 계약 3절 규칙으로 센 수(표시 4) |
|---|---|---|---|
| 0 | fillText | - | 4 |
| 1 | strokeText | - | 4 |
| 2 | fillText → strokeText | 동일 | 4 |
| 3 | ignoreText | - | 4 |
| 4 | fillText → clipText → popClip | **다름** | **8** |
| 5 | strokeText → clipText → popClip | **다름** | **8** |
| 6 | fillText → strokeText → clipText → popClip | fill=stroke 동일, clip 은 **다름** | **8** |
| 7 | clipText → popClip | - | 4 |

추가 관측

- `clipText` 는 fill/stroke 와 별개로 만든 텍스트 객체이고, 같은 `BT … ET` 의 Tr 4–7 글리프를 모아 한 객체로 보낸다. 색 변경으로 fill 이 두 번 나뉘어도(`fillText(AB)`, `fillText(CD)`) clip 은 `clipText(ABCD)` 한 번이다.
- Tr 4 와 Tr 7 이 한 `BT` 에 섞이면 Tr 7 글리프는 clipText 에만 있다(`fillText(AB)`, `clipText(ABCD)`). 그래서 Tr 7 글리프는 fill/stroke 보다 늦게(ET 시점) 온다.
- 구조화 텍스트도 Tr 4–6 글리프를 두 번 담는다(같은 원점·유니코드의 줄이 2개). Tr 7 은 1개, Tr 0–3 은 1개.
- 포인터 비교의 전제: 콜백마다 JS 래퍼(`Text`)가 새로 생기고, 래퍼를 콜백 직후 `destroy()` 하면 C 객체가 해제되어 다음 텍스트 객체가 같은 주소를 받는다. 서로 다른 텍스트 객체 100개에서 직전과 포인터가 같았던 횟수: 래퍼 유지 0회, 즉시 `destroy` 99회. 포인터 동일 판정은 직전 래퍼를 다음 콜백 비교가 끝날 때까지 유지해야 한다.
- 계약 3절 문장 "포인터 동일 판정이 Tr 2·4–6 중복을 제거한다" 는 Tr 2 와 Tr 6 의 fill/stroke 쌍에만 성립한다. Tr 4–6 의 clipText 는 포인터로 제거되지 않는다.

### 2.3 계약 수정안

수정안 A(권고): **clipText·clipStrokeText 콜백은 글리프를 세지 않는다.**

| 대상 | 규칙 |
|---|---|
| core | fillText·strokeText·ignoreText 의 글리프만 센다(같은 텍스트 객체를 연속으로 받은 fill→stroke 는 한 번). clipText·clipStrokeText 는 세지 않는다 |
| pdf-ops | Tr 0–6 글리프는 센다. Tr 7 글리프는 `seq` null 로 두고 제한 사유를 단다(V5 의 `optional-content` 와 같은 처리, 사유 이름은 신규 필요: 예 `clip-only-text`) |
| 효과 | Tr 0–6 은 각 글리프 정확히 1. Tr 7(보이지 않는 클립 전용 글자)은 PageModel 에 들어오지 않는다. 휴리스틱 없이 두 쪽이 같은 수를 센다 |
| 변경 파일 | `docs/m1-contract.md` 3절(규칙·V3·V5), `packages/shared-types/src/source-map.ts` `EDIT_LIMIT_REASONS` 에 사유 1개, `page-model.ts` 머리말 |
| core 의 구조화 텍스트 처리 | Tr 4–6 의 구조화 텍스트 두 번째 줄(중복)과 Tr 7 줄은 짝이 되는 Device 글리프가 없으므로 PageModel 에서 뺀다(원점·유니코드 1:1 소비 후 남는 글자) |

수정안 B: clipText 를 세되 직전 fill/stroke 글리프와 (폰트, gid, trm) 이 순서대로 같으면 중복으로 본다.

| 항목 | 내용 |
|---|---|
| 장점 | Tr 7 글리프도 PageModel 에 들어온다(계약 현행 의도 유지) |
| 단점 | 휴리스틱이다. 같은 위치에 겹쳐 그린 Tr 0 글리프 뒤의 Tr 7 글리프는 중복으로 오판되어 pdf-ops 와 총수가 어긋난다. Tr 7 이 같은 `BT` 의 일반 글리프와 섞이면 Tr 7 글리프 순서가 실행 순서와 달라진다(ET 시점 전달). pdf-ops 는 모든 글리프를 세므로 오판 시 이후 seq 전체가 밀리고 `linkPage` 원점 재동기화에 의존한다 |

판단 근거: 매칭 키는 "순서 번호"이고 원점은 검증용이므로(계약 3절) 규칙이 결정적이어야 한다. A 는 결정적이다. Tr 7 은 화면에 보이지 않는 클립 마스크이며 선택·검색·편집 대상 텍스트가 아니라고 판단한다. 사용자 승인이 필요한 항목이다.

## 3. 구현 범위

(구현 후 작성)
