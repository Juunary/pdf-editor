# M1 pdf-ops: 콘텐츠 스트림 인터프리터 · 원본 연결 정보 · 매칭

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-19 |
| 브랜치 | `m1-pdf-ops`(기준 `97a6fb4`, worktree `/mnt/nas4/kjune/pdf-editor-m1-pdf-ops`) |
| 범위 | `docs/m1-contract.md` 5.1절 |
| 상태 | **중단(계약 불일치 보고 대기).** 검증 전제 V3·V5 가 MuPDF 1.28.1 실측과 어긋난다. 계약 7절에 따라 `buildSourceMap`·`linkPage` 구현을 멈추고 재현 테스트·수치·수정안을 남긴다 |
| 측정 환경 | 서버 `sailab01`, Node 22, npm `mupdf` 1.28.1, `Page.runPageContents(device, Matrix.identity)`(주석 제외) |

## 1. 이번 단계 산출물

| 파일 | 내용 |
|---|---|
| `packages/pdf-ops/test/helpers/device-log.ts` | 테스트 전용 Device 기록 헬퍼(콜백 순서·텍스트 객체 포인터·글리프 gid/trm). 패키지에서 내보내지 않는다 |
| `packages/pdf-ops/test/mupdf-device-premises.test.ts` | V1–V5 와 에뮬레이션 대상 동작을 실측값으로 고정한 테스트 18건. 계약과 어긋나는 항목은 이름에 "계약 불일치" 표기 |

재현: `pnpm --filter @pdf-editor/pdf-ops exec vitest run test/mupdf-device-premises.test.ts`

## 2. 검증 전제 확인 결과(실측 2026-10-19)

| # | 전제(계약 3절) | 결과 | 근거 테스트 |
|---|---|---|---|
| V1 | Device 콜백은 Form 재귀를 포함해 콘텐츠 실행 순서로 온다 | **성립.** /Contents 배열 3개 + 중첩 Form 2단에서 실행 순서와 일치. 단, Form `Do` 마다 내용보다 먼저 BBox `clipPath` 1개가 온다(paintSeq 1 소비) | V1 |
| V2 | 여러 Tj/TJ 를 한 텍스트 콜백으로 묶을 수 있으나 글리프 순서는 보존 | **성립(ET 재전송 제외).** Tj·TJ·Td·T*·'·"·Tf 변경·q 는 한 콜백으로 묶이고 색 변경·Q 는 나눈다. 표시 시점 글리프 순서는 보존된다. ET 재전송(V3 참고)만 순서가 뒤로 간다 | V2 |
| V3 | Tr 3 은 ignoreText, Tr 7 은 clipText. 포인터 동일 판정이 Tr 2·4–6 중복을 제거 | **불일치.** Tr 2 는 성립(fill→stroke 같은 포인터). Tr 4–6 의 클립 부분은 다른 텍스트 객체로 ET 에서 온다 → 포인터 규칙으로는 Tr 4–6 글리프가 2번 센다. 꺼진 /OC·Tr 혼합 시 ET 재전송이 ignoreText 로 오거나 사라진다 | V3 |
| V4 | 채움+선(B·B*·b·b*)은 fillPath → strokePath 2개 | **성립.** 4개 연산 모두 2개. 패턴 색이면 콜백 수가 달라진다(5절) | V4 |
| V5 | 꺼진 /OC 는 Device 에 오지 않는다 | **불일치.** fill/stroke 경로·Tr 0–2 텍스트·이미지·셰이드·/OC 꺼진 Form 은 오지 않는다. 그러나 `W n` clipPath, Form BBox clipPath, Tr 3 ignoreText, Tr 4–7 ET 재전송은 꺼진 /OC 안에서도 온다 | V5 |

## 3. 불일치 상세

### 3.1 V3: 클립 텍스트의 ET 재전송

MuPDF 는 BT…ET 안에서 Tr 4–7 로 표시한 글리프를 따로 모아, ET 에서 새 텍스트 객체 1개로 다시 보낸다(이하 "ET 재전송"). 표시 시점 콜백과 포인터가 다르다. 재전송 글리프의 gid·trm 6값은 표시 시점 콜백과 비트 단위로 같다(테스트 "ET 재전송 글리프의 gid·trm …").

글리프 1개(Tr m)가 Device 에 오는 시점

| Tr | 표시 시점(보이는 콘텐츠) | 표시 시점(꺼진 /OC) | ET 재전송 대상 |
|---|---|---|---|
| 0 | fillText | 없음 | 아니오 |
| 1 | strokeText | 없음 | 아니오 |
| 2 | fillText → strokeText(같은 포인터) | 없음 | 아니오 |
| 3 | ignoreText | ignoreText | 아니오 |
| 4 | fillText | 없음 | 예 |
| 5 | strokeText | 없음 | 예 |
| 6 | fillText → strokeText(같은 포인터) | 없음 | 예 |
| 7 | 없음 | 없음 | 예 |

ET 재전송 콜백 종류는 **그 BT 에서 마지막으로 글리프를 낸 Tr** 로 정해진다(꺼진 /OC 여부와 무관). Tr 변경·빈 문자열만으로는 바뀌지 않는다.

| BT 마지막 글리프의 Tr | ET 재전송 |
|---|---|
| 4–7 | clipText(그 BT 의 Tr 4–7 글리프 전체, 표시 순서) |
| 3 | ignoreText(같은 글리프들), 마지막 ignoreText 다음 |
| 0–2 | 보내지 않음(Tr 7 글리프는 Device 에 전혀 오지 않음) |

실측 예(테스트 V3·V5, 표기 `종류:글리프`, `=` 는 직전과 같은 포인터)

| 콘텐츠(BT…ET 안) | 콜백 | 포인터 규칙 계수 | 표시 글리프 수 |
|---|---|---|---|
| `4 Tr (Ab) Tj (Cd) Tj` | fill:AbCd, clip:AbCd | 8 | 4 |
| `6 Tr (Ab) Tj` | fill:Ab, stroke=:Ab, clip:Ab | 4 | 2 |
| `7 Tr (A) Tj 4 Tr (B) Tj` | fill:B, clip:AB | 3 | 2 |
| `4 Tr (Ab) Tj 0 Tr (Xy) Tj 7 Tr (Cd) Tj 3 Tr (In) Tj` | fill:Ab, fill:Xy, ignore:In, ignore:AbCd | 10 | 8 |
| `7 Tr (A) Tj 0 Tr (B) Tj` | fill:B | 1 | 2(A 는 Device 에 안 옴) |
| `4 Tr (A) Tj 1 Tr (B) Tj` | fill:A, stroke:B | 2 | 2(A 의 클립 없음) |

결론: "포인터 동일 연속 = 1회" 규칙은 Tr 2·6 의 fill/stroke 만 합치고, Tr 4–6 의 ET 재전송을 합치지 못한다. 계약 머리말의 의도("모든 표시 글리프를 정확히 한 번")와 규칙(포인터)이 서로 다르다. core 가 규칙대로 구현하면 Tr 4–6 글리프가 2번 세지고, pdf-ops 는 어느 쪽을 따라야 할지 정할 수 없다.

### 3.2 V5: 꺼진 선택적 콘텐츠

| 꺼진 /OC 안의 콘텐츠 | Device |
|---|---|
| fill/stroke 경로, 이미지(XObject·인라인), `sh`, Tr 0–2 텍스트, Tr 4–6 의 표시 부분 | 오지 않음 |
| Form 사전 `/OC` 가 꺼진 Form(`Do`) | BBox 클립·내용 모두 오지 않음 |
| `W n` | clipPath(paintSeq 소비) |
| `/OC` 없는 Form 을 꺼진 BDC 안에서 `Do` | BBox clipPath(paintSeq 소비), 내용의 칠하기는 오지 않음 |
| Tr 3 텍스트 | ignoreText(glyphSeq 소비) |
| Tr 4–7 텍스트 | 3.1 규칙대로 ET 재전송(clipText 또는 ignoreText, glyphSeq 소비) |

실측 예: `/OC /OC1 BDC q 10 10 30 30 re W n Q /Fx Do EMC` + 꺼진 BDC 안 `3 Tr (H3) Tj` → clipPath, clipPath, ignore:H3. 꺼진 BDC 안 `1 Tr (S1) 2 Tr (S2) 5 Tr (S5) 6 Tr (S6)` → clip:S5S6.

결론: "seq null + optional-content" 를 꺼진 /OC 의 모든 글리프에 적용하면 core 계수와 어긋난다(위 두 예에서 glyphSeq 6·paintSeq 2 차이).

## 4. 계약 수정안(메인 세션 결정 필요)

### 4.1 glyphSeq(V3) — 안 A 권장

**안 A: 글리프는 첫 Device 등장에서 1 번 센다(타입 변경 없음).**

- page-model.ts 머리말·계약 3절 규칙 문구 교체:
  - fillText·strokeText·ignoreText·clipText·clipStrokeText 의 글리프마다 1. 단 다음 두 경우는 세지 않는다.
  - (a) 직전 텍스트 콜백과 포인터가 같은 fill/stroke 콜백(Tr 2·6).
  - (b) ET 재전송 글리프: clipText·clipStrokeText·ignoreText 콜백의 글리프 중 (폰트 포인터, gid, trm 6값)이 같은 글리프가 "직전 초기화 이후 fillText·strokeText 로 센 글리프" 목록에 있으면 그 항목을 하나 소비하고 세지 않는다. 목록은 clipText·clipStrokeText 콜백 뒤, 그리고 1개 이상 소비한 ignoreText 콜백 뒤에 비운다.
  - Tr 7 글리프와 꺼진 /OC 의 Tr 4–7 글리프는 ET 재전송에서 처음 오므로 그때 번호를 받는다.
- pdf-ops: 3.1 표대로 첫 등장 시점을 에뮬레이션한다(표시 시점 번호, ET 시점 번호, Device 에 안 오는 글리프는 null). 판정이 결정적이다.
- 한계(core 판정 b 의 오판): 같은 폰트·gid·trm 이 비트 단위로 같은 글리프를 다른 BT 에서 Tr 0–2 로 그린 뒤 Tr 3·7 로 다시 그리는 경우(예: 같은 텍스트로 그린 뒤 같은 위치에 Tr 7 클립, 같은 폰트 Tr 3 덧씌움), 패턴 색 Tr 4–6 텍스트. 이때 양쪽 총수가 어긋나며 `linkPage` 원점 재동기화로 국소 복구한다. 해당 글자는 `unmatched`.

**안 B: 모든 텍스트 콜백 글리프를 센다(포인터 동일 연속만 1회, 현재 규칙 문구 그대로).**

- core 는 판정 없이 정확하다. pdf-ops 도 결정적으로 에뮬레이션한다.
- Tr 4–6 글리프는 번호가 2개(표시 시점, ET 재전송)다. `SourceGlyph` 에 재전송 번호 필드(예: `resendSeq: number | null`) 추가가 필요하다(shared-types 변경).
- PageModel.chars 에 Tr 4–6 글리프가 2번 들어간다. 선택 층·복사 중복을 막으려면 core 또는 viewer 가 재전송 글자를 걸러야 하며, 그 판정은 안 A 의 (b)와 같은 휴리스틱이 된다.
- 계약 머리말의 "Tr 2·4·5·6 은 한 번으로 센다" 문구를 "Tr 2·6" 으로 고쳐야 한다.

권장 근거: 안 A 는 타입 변경이 없고 "표시 글리프 1개 = 번호 1개" 의도를 유지한다. 휴리스틱 오판은 비트 단위 같은 위치 덧그리기에서만 생기고 매칭 재동기화로 국소화된다. 안 B 는 계수는 정확하나 중복 글자 처리를 하위(core·viewer)로 넘긴다.

### 4.2 V5 문구 교체안

> V5: 꺼진 선택적 콘텐츠 안의 fill/stroke 경로·이미지·셰이드·Tr 0–2 텍스트(Tr 4–6 의 표시 부분 포함)와 `/OC` 가 꺼진 Form·이미지 XObject 는 Device 에 오지 않는다. 클립(`W n`, Form BBox), Tr 3 텍스트, Tr 4–7 의 ET 재전송은 온다. pdf-ops 는 Device 에 오지 않는 글리프만 `seq` 를 null 로 두고, 꺼진 /OC 안의 연산 전부에 `optional-content` 제한을 단다.

타입 변경 없음. core 영향 없음(콜백을 받은 대로 센다).

### 4.3 paintSeq 보충 문구(계약 위반 아님, 명확화)

> Form XObject `Do` 는 내용 앞에 BBox `clipPath` 1개를 보낸다(paintSeq 1, SourceMap 에서는 그 `Do` 연산의 `paintSeq`). 경로가 비어도 칠하기 연산은 콜백을 보낸다.

`SourceOp.paintSeq` 주석의 "xobject(이미지)" 를 "xobject(이미지·Form BBox 클립)" 으로 고치는 것을 제안한다.

## 5. 계약과 충돌하지 않는 에뮬레이션 대상(실측 2026-10-19)

수정안 확정 후 `buildSourceMap` 이 계수에 반영할 MuPDF 동작이다. 근거는 테스트 마지막 describe 블록.

| 상황 | Device 콜백 | 처리 방침 |
|---|---|---|
| 셰이딩 패턴 색으로 f / S / B | clipPath+fillShade / clipStrokePath+fillShade / 4개 | 연산 paintSeq 를 그 수만큼 부여 |
| 셰이딩 패턴 색 텍스트 | 표시 시점 clipText + fillShade | 글리프는 표시 시점 번호, fillShade 는 paintSeq |
| 타일링 패턴 색 칠하기 | clipPath + beginTile + 타일 내용 콜백(1회) | 타일 내용의 글리프·칠하기는 번호만 소비(소유 연산 없음, `outside-page-content`). 타일을 여러 번 그리는 기하 조건은 재동기화로 처리 |
| SMask 활성 중 칠하기 | 칠하기마다 마스크 그룹 BBox clipPath + 마스크 내용 콜백 후 본 칠하기 | 마스크 내용 번호는 소유 연산 없이 소비. 텍스트 실행 단위 반복 조건은 구현 시 추가 실측 |
| Type3 폰트 | Tr 1 → fillText, Tr 7 → ET 에서 ignoreText(d1·d0 모두 표시는 fillText, 글리프 프로시저 콜백 없음) | Tr 0–7 전체 매핑을 구현 시 실측 후 반영 |
| 이미지 XObject / 인라인 이미지 / `/IM true` 인라인 | fillImage / fillImage / fillImageMask | 연산 paintSeq 1 |
| `ca`·블렌드 | beginGroup/endGroup 만 추가 | 계수 없음 |
| BT 안의 경로 칠하기 | 묶인 텍스트보다 먼저 옴 | 번호 체계가 달라 영향 없음 |

## 6. Action Items

| # | 내용 | 담당 |
|---|---|---|
| P1 | 4.1 안 A/B 결정, 4.2·4.3 문구 반영 후 `m1` 계약 커밋 | 메인 세션 |
| P2 | core(`m1-core`)에 같은 내용 전달: 포인터 규칙만으로는 Tr 4–6 이 2번 센다, 꺼진 /OC 에서 클립·Tr 3·ET 재전송이 온다 | 메인 세션 |
| P3 | 계약 커밋 머지 후 `buildSourceMap`·`linkPage` 구현 재개(토크나이저 확장·상태 머신·글리프 원점·제한 사유는 결정과 무관하게 바로 진행 가능) | pdf-ops |
