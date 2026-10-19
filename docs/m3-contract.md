# M3 계약: 문단 텍스트 재작성(편집 → 영역 안 리플로우 → 초과 처리 → 저장)

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-19 |
| 범위 | PLAN.md 6절 M3(텍스트 재작성) 병렬 구현의 공통 기준 |
| 기준 | `m3` 브랜치의 계약 커밋(이 문서, `packages/shared-types/src/edit.ts`·`rpc.ts`·`save.ts`·`source-map.ts` 추가분, `packages/reflow` 골격, pdf-ops·core 연결부). 모든 M3 작업은 이 커밋에서 시작한다 |
| 변경 권한 | `packages/shared-types`, `packages/reflow/src/index.ts` 의 내보낸 타입(`FaceSource`·`FontFace`·`FontSegment`·`WritableGlyph`·`ReflowInput`·`ReflowResult`), pdf-ops `paragraph-edit.ts` 의 내보낸 시그니처, 루트 설정(eslint·tsconfig.base·turbo·pnpm-workspace), `pnpm-lock.yaml`, 새 패키지·새 의존성은 메인 세션만 바꾼다(PLAN.md 10절) |
| 입력 | M1 계약(`docs/m1-contract.md`: SourceMap·매칭·좌표계), M1 결정(`docs/m1-decisions.md`: A7-2 SourceMap 기반 제거 등), M2 계약(`docs/m2-contract.md`: PageLayout), 1.2절의 이관 Action Item |
| 일정 | PLAN.md 6절 계획은 2026-12-14~2027-01-17(5주). 2026-10-19 착수 |
| 상태 표기 | 확정 = 근거가 있고 바꾸지 않음. 권고 = 메인 세션 결정, 사용자 확인 전. 결정 대기 = 사용자 결정 필요 |
| 변경 이력 | 수정 1(2026-10-19, S3 core 실측 보고): 폴백 폰트 임베딩과 Info 생성을 저널을 켜기 전 한 번으로 바꿈(D4·D9·5.7), FontManager 생성자를 `FallbackFontSource` 로 바꿈. 수정 2(2026-10-19, S2 reflow 실측 보고): 폴백 서브셋 cmap 을 일대일로 다시 만듦(D12), 입력 정규화에 U+00A0 → U+0020 추가(1.3·5.9) 수정 3(2026-10-19, S1 pdf-ops 실측 보고): BT 나누기의 Tlm 복원을 원 줄 설정 연산 재실행으로(D3 규칙 2), `insertion-clipped` 에 직사각형 클립이 원 글리프를 덮지 않는 경우 추가 |
| 독립 검토 | 2026-10-19 읽기 전용 검토(판정 REVISE: BLOCKER 1·HIGH 6·MEDIUM 9·LOW 12)를 이 판에 반영했다. 저널·폰트·harfbuzz 실측 주장은 메인 세션이 재현했다(11절) |

## 1. 완료 기준과 범위

### 1.1 M3 완료 기준(DoD)

끝까지 통과해야 하는 흐름: 문서 열기 → 문단 선택 → 편집(라틴·한글·IME) → 영역 안 리플로우 → 초과 처리 → 저장 → 재열기 → 검색·복사 → 같은 문단 재편집(같은 세션과 재열기 후 새 세션 둘 다).

| 축 | 기준 | 측정 |
| --- | --- | --- |
| 편집 대상 | 흐름 문단(`table`·`figure` null, 가로 줄)을 편집한다. 편집할 수 없으면 사유를 표시한다(5.1) | 코퍼스 전수 편집 가능 비율·사유 분포. 수치 목표는 두지 않되, 결과를 사용자에게 보고하고 확인받는 것을 완료 조건으로 한다(8.2 표본이 편집 가능 문단만 고르는 편향 보완) |
| 시각(영역 밖) | 편집한 쪽의 변경 허용 영역 밖 렌더 변화 0 px, 편집하지 않은 쪽 0 px. 세 엔진(MuPDF·pdf.js·Poppler) | 8.2. 정의는 8.3. 예외는 사유를 붙여 보고하고 사용자 승인 |
| 시각(새 글자) | 쓴 글리프 중 공백류가 아닌 것마다 그 글리프 상자 안 잉크 ≥ 1 px(세 엔진). 글리프가 있다고 판정했는데 외곽선이 비어 안 보이는 조용한 실패를 잡는다 | 8.2 |
| 텍스트 | 저장 후 재추출한 편집 블록 글자 = 입력 텍스트(정의 8.3). 폴백 범위 밖 글자(`glyph-missing`)는 입력에서 뺀다 | 8.2 표본 100% |
| 검색 | MuPDF 검색으로 새 단어를 찾고, 하이라이트 quad 중심이 해당 `PlacedGlyph` 상자 안 | 8.2 표본 100% |
| 순서(A9) | 재추출 순서에서 새 문단이 원래 자리에 있다(정의 8.3) | 8.2 표본 100%. `reading-order-approximate` 경고가 붙은 편집은 사유와 함께 따로 센다 |
| 객체 | 편집하지 않은 쪽의 쪽 사전·콘텐츠·리소스 객체 변경 0. 원본 폰트 객체 불변. 폴백 폰트는 문서당 최대 1개 추가·저장 시 서브셋 | 객체 diff |
| 편집 동작 | 편집 중 글자 단위 undo/redo, 문단 편집 단위 undo/redo, 연속 편집, 같은 문단 재편집, 저장 후 재편집·undo, 편집 취소, 폴백을 쓴 초안 취소·undo 뒤 새 편집 | Playwright·core 단위 |
| IME | 1.3 시나리오 I1–I8 | Playwright(CDP `Input.imeSetComposition`·`Input.insertText`) + Windows 사용자 확인 |
| 초과 | 3선택(영역 넓히기·글자 줄이기·그대로 두기) 동작, 자동 클립 없음(PLAN.md 1.3) | 단위·Playwright |
| 저장 | 편집 후 저장은 전체 저장이고 저널 단계를 만들지 않는다(D9). 저장 전 힙 경고(A3-2), 저장 실패 복구(A3-3) | 단위·Playwright(실패 주입) |
| 성능 | 편집 반응 시간. 잠정 목표 p95 100 ms. 측정 정의는 8.4. 첫 측정 후 메인 세션이 사용자 확인을 받아 고정(PLAN.md 8절) | Playwright |

### 1.2 이관 항목

| 항목 | 출처 | 이 계약의 처리 |
| --- | --- | --- |
| SourceMap 기반 제거 후속 1: 연산 일부만 지우기 | `docs/m1-decisions.md` 4절 | D2·D3 |
| 후속 2: Form 안 텍스트(인스턴스 복제 후 제거) | 같은 절, A1-1 | D2(바이트 복제 함수 새로 작성) |
| 후속 3: Type3·세로쓰기 제거 | 같은 절 | M3 범위 밖. 편집 제한(5.1) |
| 후속 4: 지운 텍스트의 marked content·링크 | 같은 절, C2, A2-1 | D1·D8 |
| 후속 5: 편집 후 SourceMap 재생성 | 같은 절 | 5.7(커밋 시 쪽 캐시 무효화) |
| A7-4 배치 영역 ∩ CropBox ∩ BBox | `docs/m0-corpus-recheck.md` 8절 | 5.4 `areaLimit` |
| A7-7 태그 PDF 기본 동작 | 같은 절 | D1 |
| A2-1·A7-8 링크 | `docs/m0-dod-xobject-redact-save.md` 2.6, 코퍼스 8절 | D8 |
| A2-2 Redact 보고 UI | DoD 문서 2.6 | 5.9 |
| A3-2 힙 경고 UI | DoD 문서 3.6 | 5.8·5.9 |
| A3-3 저장 실패 복구 | DoD 문서 3.6 | D6·5.8 |
| A3-7 `objstms` 저장 옵션 | DoD 문서 3.6 | D9(저널이 켜진 문서는 저장을 저널 작업으로 감싸야 한다) |
| A3-9 재저장 기준 | DoD 문서 3.6 | D9 |
| A5-3 DNR file:// 안내 | 코퍼스 8절 | 5.9 |
| A9 편집 문단 읽기·복사 순서 | `docs/m0-day1-log.md` 8절 | D3 |
| A10 임베디드 Ctrl+S 덮어쓰기 재확인 | Day 1 로그 8절 | 통합 후 사용자 확인(7절) |
| W4-1 역할 채점, W4-4 문단 경계 회귀 | `docs/m2-accuracy.md` 7.1 | 작업 S5 |

### 1.3 IME 시나리오

| # | 시나리오 | 기대 |
| --- | --- | --- |
| I1 | 한글 조합 중 표시 | 조합 문자열이 미리보기에 밑줄로 보이고 캐럿이 조합 끝에 있다. 확정 시 한 음절이 들어간다 |
| I2 | 조합 중 Backspace | 자모 단위 삭제는 IME 가 처리한다. 편집기는 조합 문자열만 갱신한다 |
| I3 | 조합 중 리플로우 | 줄 끝에서 조합 글자가 다음 줄로 넘어가도 캐럿·밑줄이 따라간다 |
| I4 | 조합 중 화살표·클릭 | 조합을 확정한 뒤 이동한다 |
| I5 | 조합 중 단축키(Ctrl+Z 등) | 무시한다 |
| I6 | undo 단위 | 연속 입력(0.5초 정지·캐럿 이동·공백·문장부호 경계까지)이 한 단위. 조합 확정 한 번은 그 단위에 들어간다 |
| I7 | 한자 변환 | 후보 선택 결과가 들어간다. KS X 1001 한자는 폴백 폰트에 있다(D12). 원본·폴백 폰트 모두 글리프가 없으면 `glyph-missing` 경고와 함께 그 글자는 쓰지 않는다 |
| I8 | 조합 중 편집 종료(바깥 클릭) | 조합을 확정한 뒤 커밋한다. 조합 중 Esc 는 IME 가 먼저 쓰므로 편집 종료로 보지 않는다 |

- 입력·붙여넣기 텍스트는 NFC 로 정규화하고, U+00A0(NBSP)은 U+0020 으로 바꾼다(NFD 자모 입력 대비, 폴백 cmap 에 U+00A0 없음 — 수정 2).

### 1.4 범위 밖(M3)

- 표 셀 텍스트(M4), 도형 라벨, 세로쓰기·회전 문단, Type3 폰트 문단(5.1 제한).
- 문단 간·쪽 간 밀어내기, 쪽 넘김(PLAN.md 1.2).
- 모양 바꾸기 UI(굵게·크기·색·폰트 선택). 새로 입력한 글자는 이웃 글자의 모양을 따른다(D4).
- 빈 곳에 새 문단 만들기.
- 구조 트리(StructTreeRoot·ParentTree) 수정(D1).
- 옛한글(첫가끝 자모 U+1100 대): 번들 폴백 서브셋에 없다.

## 2. 결정 사항

| # | 주제 | 상태 |
| --- | --- | --- |
| D1 | 태그 PDF(A7-7, PLAN.md 1.4) | **확정**(2026-10-19 사용자 결정, 권고안) |
| D2 | 텍스트 제거 경로 | 권고 |
| D3 | 새 텍스트 삽입 위치(A9) | 권고 |
| D4 | 폰트 선택(PLAN.md 3.3) | 권고 |
| D5 | 셰이핑(PLAN.md 2절) | 권고 |
| D6 | undo·로그·복구(PLAN.md 3.2, A3-3) | 권고(V1 확인 후 확정) |
| D7 | 편집 중 미리보기 | 권고 |
| D8 | 링크(A2-1·A7-8) | 권고 |
| D9 | 저장과 저널, 재저장 기준(A3-7·A3-9) | 권고(저널 상호작용은 실측, 11절) |
| D10 | 줄 나눔·배치 | 권고(5.4) |
| D11 | 편집 진입·종료 조작 | 권고(5.9). Esc 동작은 사용자 확인 권고 |
| D12 | 폴백 폰트 범위(한자·기호) | **확정**(2026-10-19 사용자 결정, 안 A) |

### D1 태그 PDF

근거: 코퍼스 편집 표본 53문단 중 31문단이 MCID 가 있는 쪽이다(`docs/m0-corpus-recheck.md` 2.7). 편집을 막으면 v1 사용 범위가 크게 준다.

| PLAN.md 1.4 항목 | 결정 |
| --- | --- |
| 1. 지원 여부 | 편집 허용. 태그 쪽 편집을 시작할 때 "구조(읽기 순서·태그)는 갱신하지 않음" 을 표시한다. 설정으로 태그 쪽 편집 막기를 둔다(기본 끔) |
| 2. 구조 갱신 | 구조 트리는 고치지 않는다. 편집 블록 호출(`Do`)이 지운 문단 첫 글리프의 MCID marked content 안에 들어가면 구조 연결이 유지된다(`tagged-structure-kept`, V5 로 확인). 들어가지 못하면 경고 `tagged-structure-unlinked`. 편집 블록 Form 은 `/StructParents`·MCID BDC 를 갖지 않는다. Form 복제본이 `/StructParents` 를 가지면 복제본에서 지우고 `tagged-structure-unlinked`(같은 ParentTree 키를 두 스트림이 갖지 않게) |
| 3. 보존 불가 시 | 저장 전 경고(구조 연결이 끊긴 문단 수, `SavePlan.edits`). 설정의 편집 막기 |
| 문서 메타 | 저장 때 Info `/PdfEditorEdits` 기록(5.6) |
| ActualText | 지운 글리프가 `/ActualText` 가 있는 MC 안이면: 그 MC 의 글리프를 모두 지우는 경우 BDC 속성에서 ActualText 를 뺀다(인라인 사전은 바이트 교체, `/Properties` 이름이면 그 연산이 있는 holder(쪽 또는 Form 복제본) Resources 에 ActualText 를 뺀 사본). 경고 `actualtext-cleared`. 일부만 지우면 편집 제한 `actualtext-partial`. 이유: 남은 ActualText 가 옛 텍스트를 복사·검색 결과로 내보낸다 |

### D2 텍스트 제거 경로

- 기본: `removeTextShowOps`(M1 A7-2) 의 규칙(같은 전진량 숫자 TJ, 명세 폭, 공유 스트림 사본).
- M3 에서 더한다.
  - (a) 연산 일부만 지우기: 문단 글리프와 다른 글리프가 한 연산에 섞이면 글리프 경계에서 나눠, 남길 글리프는 문자열로, 지울 글리프는 같은 전진량의 숫자 조정으로 바꾼 TJ 로 다시 쓴다(`'`·`"` 는 앞 연산 효과 `T*`·`Tw`·`Tc` 를 보존).
  - (b) Form 안 텍스트: 편집 위치의 Form 사용 경로를 바이트 단위로 복제(상위 체인 포함, 이름 피연산자만 교체 — PLAN.md 3.4 의 방식과 같고 redaction 은 쓰지 않음)한 뒤 복제본 스트림에 같은 제거를 적용한다. 폰트는 그 Form 의 /Resources 에서 찾는다. 기존 `redactFormUsage` 는 쪽 재직렬화라 SourceMap 범위를 쓸 수 없으므로 새 함수를 만든다.
- 한 스트림의 제거·삽입·이름 교체·ActualText 교체는 그 스트림 원본 바이트 기준의 교체 목록 하나로 한 번에 적용한다(먼저 쓴 교체가 뒤 오프셋을 무효로 만들지 않게). 공유 스트림 사본도 이 단계에서 한 번 만든다.
- MuPDF redaction 대체 경로는 M3 편집에서 쓰지 않는다. 근거: 쪽 전체 재직렬화로 SourceMap 이 무효가 되고 편집하지 않은 줄이 움직인다(C2, 100블록 중 21블록 렌더 변화). 제거가 건너뛰는 연산을 포함한 문단은 편집 제한(`remove-skipped`, `code`)으로 표시한다. PLAN.md 3.1·3.4 의 "대체 경로" 문구를 고친다(9절).
- `removeTextShowOps` 의 건너뜀 사유는 한국어 문자열에서 코드(`RemoveSkipCode`)로 바꾼다. 문자열은 `detail` 로 남긴다.

### D3 새 텍스트 삽입 위치(A9)

현재 `appendPageContent` 는 쪽 콘텐츠 끝에 덧붙여, 편집한 문단이 복사·읽기 순서에서 쪽 끝으로 간다(Windows W1 사용자 보고, pypdfium2 추출 동일). M3 는 원래 자리에 넣는다.

편집 블록

- 새 텍스트는 문단마다 전용 Form XObject("편집 블록")에 쓰고, 삽입점에 `q /<이름> Do Q` 를 끼워 넣는다. 초안 갱신·재편집은 이 Form 스트림만 다시 쓴다.
- `/Matrix` = 삽입점 CTM 의 역행렬. 그래서 블록 안 좌표는 기본 사용자 공간이고, 쓰기는 `userToPage` 역행렬만 쓴다. 삽입점 CTM 이 특이 행렬이면 편집 제한 `singular-ctm`.
- `/BBox` = 사용자 공간으로 옮긴 `areaLimit`(5.4).
- `/Resources` = 쓰는 폰트·색공간·ExtGState 만.
- 블록 스트림 사전에 기록하는 키:

| 키 | 값 |
| --- | --- |
| `/PdfEditorEdit` | 편집 id 문자열(`crypto.randomUUID()`) |
| `/PdfEditorFormat` | JSON 문자열: `ParagraphFormat`, `runs`(텍스트와 모양: 크기·굵게·기울임·색·원 폰트 이름·합성 여부), 삽입 방식. 재열기 뒤 재편집의 시작 상태에 쓴다(5.3) |

- 사용 위치가 1곳이고 `/PdfEditorEdit` 가 있는 Form 은 세션과 무관하게 편집 블록이다. 그 블록의 글자를 하나라도 포함한 문단을 편집하면 대상은 블록 전체이고, 원 연산 제거 없이 블록 스트림만 다시 쓴다(`rewrite-block`). 그래서 재편집해도 Form 중첩이 깊어지지 않는다.

삽입점(그 연산이 있는 스트림의 바이트 위치)

- 기준 글리프 = 지울 글리프 중 실행 순서상 첫 글리프. 기준 연산 = 그 글리프의 연산.
- 규칙
  1. 기준 연산을 담은 BT 안에서 기준 글리프 앞에 남길 보이는 글리프가 없으면 그 BT 바로 앞(`before-bt`).
  2. 있으면 기준 글리프 바로 앞에서 BT 를 나눈다(`split-bt`): `ET q /<이름> Do Q BT <Tlm> Tm [<n>] TJ`. 기준 연산이 일부만 지우는 연산이고 앞에 남길 글리프가 있으면, 다시 쓴 TJ 를 그 위치에서 둘로 나누고 그 사이에 넣는다.
     - `<Tlm>` 복원(수정 3): 그 BT 에서 마지막 `Tm`(없으면 BT) 이후 실행한 줄 설정 연산(`Tm`·`Td`·`TD`·`T*`, `'`·`"` 는 그 줄 이동 부분 `T*`)을 원 피연산자 바이트 그대로 순서대로 다시 실행한다. 행렬 값을 계산해 한 번의 `Tm` 으로 쓰면 결과 Tlm 은 같아도 엔진의 반올림 경로가 달라 남은 글자가 움직인다(S1 실측, arxiv-2609.09268 1쪽: `Tm` 1회 pdf.js 169 px — 유효숫자 17자리도 같음, `Td` 1회 Poppler 88 px, 원 연산 재실행 세 엔진 0 px). `TD` 를 다시 실행하면 TL 이 바뀌므로, 재실행 뒤 TL 이 그 지점의 TL 과 다르면 `<TL> TL` 을 덧붙인다.
     - `<n>` = −1000·d / (Tfs·Th). d = 마지막 줄 설정 연산(BT·Td·TD·T*·Tm·'·") 뒤 그 지점까지 실행한 표시 연산의 가로 변위 합(명세 폭, ISO 32000-1 9.4.4). n = 0 이면 TJ 를 생략한다.
     - 텍스트 상태(Tc·Tw·Tz·TL·Tf·Tr·Ts)는 그래픽 상태라 ET/BT 를 넘어 유지되고 `q`/`Q` 로 보존된다. Tm·Tlm 은 BT 에서 항등으로 초기화되므로 위처럼 되돌린다.
  3. 2의 지점에 BT 안에서 열린 marked content(BMC·BDC)가 열려 있으면 그중 가장 바깥 것의 바로 앞으로 옮기고, 옮긴 지점에서 규칙 1·2 를 다시 적용한다. 옮긴 지점과 기준 글리프 사이에 남길 보이는 글리프가 있으면 경고 `reading-order-approximate`.
- BT 나누기 제한 `bt-split-unsupported`(`detail` 에 사유):
  - 그 BT 의 어떤 연산이든 Tr 4–7(클립 텍스트). 클립은 ET 에서 BT 전체 글리프의 합집합으로 걸리므로 나누면 의미가 바뀐다(9.3.6).
  - 그 지점의 Tfs = 0 또는 Th = 0, 폰트 wmode 1, 또는 d 를 명세 폭으로 계산할 수 없음(MuPDF 대체 폰트·폭 불확실·Type3·CID 미매핑).
  - BT 안의 `q`/`Q`·`cm`(비표준)이 나누는 지점에 걸침.
- 삽입점의 그래픽 상태
  - 직사각형 클립은 `areaLimit` 에 넣는다(5.4). 직사각형이 아닌 클립이 원 문단 bbox 를 다 덮지 않으면 편집 제한 `insertion-clipped`. 직사각형 클립이 원 문단 글리프 원점을 덮지 않을 때도 `insertion-clipped` 다(수정 3, S1 실측: fed-h41 4쪽 각주는 삽입점 클립 폭 18pt, 코퍼스 48쪽 흐름 문단 12개).
  - `sourceChar` 시점의 ExtGState(ca·CA·BM·OP 등)가 삽입점과 다르면 그 gs 를 블록 Resources 에 복사해 블록 안에서 적용한다. SMask 가 다르면 편집 제한 `graphics-state-mismatch`.
  - 채움이 패턴 색이면 편집 제한 `graphics-state-mismatch`(패턴 공간은 부모 콘텐츠 스트림 기준이라 블록으로 옮기면 어긋난다, 8.7.3.1).
  - 블록은 텍스트 상태를 모두 명시한다(5.5). 앞 BT 가 남긴 Tr 3(OCR 층) 등을 물려받지 않는다.
  - BT 를 나누면 텍스트 녹아웃 단위가 바뀐다(9.3.8). 겹친 반투명 글자에서만 차이가 나므로 기록만 한다.
- Form 안 텍스트는 복제본 Form 스트림 안에 같은 규칙으로 넣는다.

### D4 폰트 선택

- 글자(클러스터) 단위로 고른다. 원본 폰트로 쓸 수 있는 글자는 원본 폰트, 아니면 폴백 폰트(Noto Sans KR glyf 서브셋 TTF, `assets/fonts/`), 둘 다 안 되면 쓰지 않고 경고 `glyph-missing`(`PlacedGlyph.font.kind = 'missing'`, .notdef 를 쓰지 않는다).
- 원본 폰트로 쓸 수 있는 조건(모두):
  - (i) 그 문자를 내는 코드가 정해진다. ToUnicode·Encoding 역매핑으로 찾고, 후보가 여럿이면 이 문서에서 쓰인 코드를 우선한다.
  - (ii) 그 코드의 글리프 외곽선이 비어 있지 않다(공백류 제외). gid/loca 존재만으로 판정하지 않는다. MuPDF·Word 류 서브셋은 안 쓰는 글리프의 외곽선만 비운다. FontFile 의 glyf/CFF 를 직접 읽거나 렌더 탐침으로 판정한다(V4).
  - (iii) 명세 폭 > 0(결합 문자 제외). pdfTeX 류는 안 쓴 코드의 /Widths 가 0 이다.
  - (iv) Type1·TrueType·Type0(Identity-H 또는 역매핑 가능한 가로쓰기 CMap).
  - 비임베디드 폰트는 (ii) 대신 원본과 같은 처리(뷰어 대체)를 받아들인다.
- 폴백 폰트 수명(저널, 11절 실측, 수정 1): 저널 작업 안에서 넣은 폰트 객체는 그 작업을 버리거나 undo 하면 xref 에서 사라진다. 같은 바이트로 다시 `addFont` 하면 MuPDF 가 문서의 폰트 표(바이트 다이제스트 키)에서 사라진 객체 번호를 그대로 돌려줘 끊긴 참조가 된다(S3 실측, 메인 세션 재현). 그래서 폴백 폰트는 core 가 저널을 켜기 직전(첫 `beginParagraphEdit`, 작업 밖)에 한 번 `embedFont` 하고, FontManager 는 그 객체(`FallbackFontSource.ref()`)만 쓴다(직접 `embedFont` 하지 않는다). 저널 밖에서 만든 객체라 취소·undo 로 사라지지 않고, 쓰지 않았으면 저장의 `garbage` 가 뺀다. 바이트를 덧붙여 다이제스트를 바꾸는 재임베딩은 취소마다 폰트 전체를 새로 넣으므로 쓰지 않는다. 편집 블록 Resources 에는 이 객체를 참조로 넣는다.
- 서브셋(A7-1): 저장할 때 D9 의 저장 작업 안에서만 `subsetFontBytes` 결과로 바꾸고, 그 작업을 버려 작업 문서는 전체 폰트를 유지한다(저장 뒤 계속 편집할 때 새 음절이 빈 글리프가 되지 않게). `subsetFonts()` 는 쓰지 않는다.
- 폴백 폰트는 Regular 하나다.
  - 굵게 구간: 합성 굵게. `2 Tr`, 선 두께 = 크기 × 0.03(블록 공간 = 사용자 공간이라 pt 그대로), `[] 0 d 0 J 0 j`, 선 색은 채움 색과 같은 색공간의 `CS`/`SCN`, 선 알파는 채움과 같게.
  - 기울임 구간: 합성 기울임. 화면(페이지 공간) 기준 오른쪽으로 기울기 0.2.
  - 경고 `synthetic-style`. 합성 여부는 `/PdfEditorFormat` 에 남아 재열기 뒤 재편집에서도 유지된다.
- 새로 입력한 글자의 모양 = 캐럿 앞 글자의 모양(문단 맨 앞이면 뒤 글자). 모양은 "원본 글자 k 의 모양 복사"(`RunStyle.sourceChar`)로 나타내고, 쓰기는 그 글자의 연산에서 폰트 리소스·채움 색 연산(원래 색공간)을 가져온다. 원 글자가 Tr 1·2 면 따른다.

### D5 셰이핑

- `packages/reflow` 는 셰이퍼 인터페이스를 둔다.
- 원본 폰트: PDF 명세 폭으로 배치하고 커닝은 하지 않는다. PDF 뷰어는 글리프 전진을 폰트 프로그램이 아니라 `/Widths`·`/W`(9.4.4 w0)로 정하기 때문이다.
- 폴백 폰트: harfbuzzjs 로 셰이핑하되 `kern` 만 켠다(`liga`·`clig`·`dlig`·`calt`·`ccmp`·`locl`·`rlig` 끔, 언어 태그 없음).
  - 불변식: 쓰는 폴백 gid 는 모두 cmap 역상에 있다(= MuPDF 가 만든 ToUnicode 로 추출된다).
  - 출력 gid 가 cmap 역상에 없으면 그 클러스터는 cmap gid + hmtx 폭으로 대신한다.
  - 근거(11절 실측): 기본 기능이면 `fi` → gid 11878, `office` → ffi 합자, `——` → 445, 한국어 태그의 공백 → 12084 처럼 cmap 에 없는 gid 가 나오고, gid 11878 은 `��` 로 추출된다.
- 전진량은 MuPDF `addFont` 가 쓴 `/W` 기준이고 커닝 조정은 TJ 숫자로 쓴다(V6).
- 의존성: `harfbuzzjs` 1.6.2(MIT, 2026-09-21 게시). V6 이 실패하면 폴백 폰트도 hmtx 폭만 쓰는 단순 셰이퍼로 두고 의존성을 뺀다.

### D6 undo·로그·복구

- 진실 원천: 원본 바이트 + 커밋된 `EditOp` 목록(PLAN.md 3.2). 뷰어도 커밋 결과의 `EditOp` 를 보관한다. undo 뒤 새로 커밋하면 뷰어는 `EditHistoryState.activeEditIds` 에 없는 `EditOp` 를 버린다.
- 세션 안 undo/redo: MuPDF 저널(`enableJournal`·`beginOperation`·`endOperation`·`abandonOperation`·`undo`·`redo`).
  - 문단 편집 하나 = 저널 작업 하나. 편집 시작에서 열고, 커밋에서 닫고, 취소는 `abandonOperation`.
  - 저널이 켜지면 작업 밖의 객체 변경은 예외다(`Can't alter an object other than in an operation`). 문서를 바꾸는 모든 경로(편집, 저장 준비, Info 생성)는 작업 안에서 한다.
  - 작업이 열린 동안 MuPDF `canUndo()`·`getJournal()` 은 예외다. 그래서 `getEditHistory` 는 core 상태로 답한다.
  - V1 이 실패하면 "원본 + 로그 재적용 + 체크포인트" 로 바꾸고, 체크포인트 간격은 재적용 시간 측정으로 정한다.
- 편집 중 글자 단위 undo/redo 는 뷰어 편집기의 텍스트 이력이다(1.3 I6 단위). 편집 밖 Ctrl+Z 는 문서 undo 다.
- 복구(A3-3)
  - Worker 예외로 세션을 쓸 수 없으면 뷰어가 Worker 를 새로 만들고, 보관한 원본(뷰어의 `Blob`)을 열고, 보관한 `EditOp` 를 `replayEdits` 로 다시 적용한다.
  - 재적용은 저널을 끈 상태로 해 힙을 줄이고, 끝난 뒤 저널을 켠다(복구 전 undo 이력은 잃는다고 사용자에게 알린다).
  - 재적용은 같은 코드·같은 폴백 폰트에서 결정적이어야 한다(통합 단계 테스트).
  - 초안 중에 Worker 가 죽으면 뷰어는 편집기 모델(텍스트·모양·형식)로 같은 문단 초안을 다시 시작한다.

### D7 편집 중 미리보기

- Worker 결과를 그대로 보여 준다. 편집 시작 때 원 문단 제거와 편집 블록 삽입을 작업 문서에 적용(초안)한다. 입력마다 리플로우 → 편집 블록 스트림 교체 → 변경 영역 렌더(`RenderRequest.clip`) → 뷰어가 쪽 캔버스에 합성한다.
- 캐럿·선택·조합 밑줄·초과 표시는 뷰어가 리플로우 결과(`ReflowSummary`)로 그린다. 빈 문단도 `lines` 가 1개 이상이라 캐럿을 그릴 수 있다.
- 뷰어는 처리 중인 요청이 있으면 마지막 입력만 보낸다(중간 입력은 합친다).
- 초안이 있는 쪽의 렌더·추출·검색은 초안 상태(작업 문서)를 돌려준다. 취소하면 그 쪽 캐시를 무효화한다.

### D8 링크

- SourceMap 기반 제거는 링크 주석을 지우지 않는다. 코퍼스의 "링크 제거 9/53"(A7-8)은 redaction 경로 측정이다.
- 편집 문단과 겹치는 링크는 그대로 두고 경고 `link-overlap` 을 표시한다. 링크 영역 재계산은 v1 범위 밖. A2-1 은 "유지 + 경고" 로 닫는다.

### D9 저장과 저널, 재저장 기준

실측(11절): 저널이 켜진 문서를 `garbage=yes,compress,objstms`(A3-7 의 현재 전체 저장 옵션)로 저장하면 저널에 "Save document" 단계가 생긴다. 저장 직후 첫 undo 는 화면에 변화가 없고, 메모리 문서의 객체 수가 바뀐다. `garbage=compact` 저장 뒤의 undo 는 예외 없이 무효가 된다. 작업이 열린 상태에서도 저장은 성공하고 초안이 파일에 들어간다.

- 저장 순서
  1. `beginOperation('save')`
  2. Info 기록(5.6)·폴백 서브셋 교체(D4)
  3. `saveToBuffer(FULL_SAVE_OPTIONS)`
  4. `abandonOperation()`
  - 저장은 저널 단계를 만들지 않고, 작업 문서는 저장 전 상태로 남는다. 실측으로 출력 반영·저널 유지·undo/redo 정상을 확인했다.
- Info 사전이 없으면 core 가 저널을 켜기 직전(작업 밖)에 만든다. `trailer.put('Info')` 는 저널에 기록되지 않아, 작업 안에서 만들면 그 작업을 버리거나 undo 한 뒤 trailer `/Info` 가 끊긴 참조로 남는다(실측, 수정 1). 이미 있는 Info 사전에 키를 더하는 것(`recordEditMetadata`)은 저널에 기록되어 저장 작업을 버리면 되돌아간다.
- 저널이 켜진 문서에는 `garbage=compact`·`deduplicate`·`linearize` 를 쓰지 않는다.
- 초안이 있는 동안 `planSave`·`save` 는 예외다. 뷰어는 Ctrl+S 때 먼저 커밋한다.
- 편집이 있는 저장은 항상 전체 저장이다. 세션에서 전체 저장을 한 번이라도 했으면 이후 저장도 전체 저장이다(증분 구간 xref 형식 문제, A3-9). 증분 저장은 편집 없는 주석·메타 저장에만 쓴다.
- 저장 뒤에도 로그와 저널은 유지한다(저장 후 undo 가능). 복구 기준은 원본 바이트 + 활성 로그다.
- `SaveRequest.changes` 가 비어 있어도 core 가 로그에서 변경 종류(`content-stream`, 폴백 사용 시 `font-embed`)를 더한다.

### D12 폴백 폰트 범위

- 이전 번들 서브셋(2,556,960 B)에는 한자가 0자이고 €(U+20AC)·™(U+2122)·첫가끝 자모가 없었다(cmap 확인). 원본 폰트가 서브셋이면 한자 변환(I7) 결과는 두 폰트 모두 글리프가 없어 쓸 수 없었다.

| 안 | 내용 |
| --- | --- |
| **A(채택)** | KS X 1001 한자 4,888자·€·™ 를 폴백 서브셋에 추가. 저장 파일에는 쓴 글리프만 서브셋으로 들어가므로 파일 크기 영향은 작고, 확장 배포 크기만 약 1.5 MB 늘어난다 |
| B | 현재 범위 유지. 한자는 `glyph-missing` 경고 후 쓰지 않음 |

- 적용(계약 커밋, 메인 세션): `scripts/fonts/build-noto-sans-kr-subset.sh` 에 €·™ 범위와 KS X 1001 한자 목록(EUC-KR 0xCAA1–0xFDFE 디코드, 4,888자)을 더해 다시 만들었다.
  - 결과 `assets/fonts/NotoSansKR-Regular-subset.ttf`: 4,083,596 B, 16,968 글리프, cmap 16,892자, sha256 `08857b9f…cb34`. 같은 명령 두 번 실행 시 해시 동일.
  - 한자 4,888자 중 4,885자 포함. 3자(U+9699·U+F95F·U+F9AA)는 원본 Noto Sans KR 정적 인스턴스 cmap 에 없다.
  - 기존 테스트 강제 실행 24/24 통과(글꼴 교체 뒤).
- 수정 2(S2 reflow 실측 보고, 메인 세션 재현): 원본 정적 인스턴스 cmap 은 317 글리프를 여러 코드 포인트가 공유한다. MuPDF `addFont` 의 ToUnicode 는 그중 가장 큰 코드 포인트를 골라, 추출 결과가 바뀌었다(공백 → U+00A0, 하이픈 → U+2011, 호환 자모 52자 → 반각, 통합 한자 259자 → 호환 한자). 그래서 서브셋 cmap 을 일대일로 만든다.
  - 뺀 코드 포인트: 호환 한자 U+F900–FAFF(NFC 가 통합 한자로 바꿈), 반각 자모 U+FFA0–FFDC, 나머지 6묶음의 패자 U+00A0·U+00AD·U+2011·U+2003·U+2012·U+301C·U+FF40. 남긴 쪽은 입력 빈도 기준: U+0020·U+002D·U+3000·U+2013·U+2035·U+FF5E.
  - 결과: 4,082,236 B, 16,966 글리프, cmap 16,567자, sha256 `e96d7e43…a287`, 같은 명령 재실행 시 해시 동일.
  - KS X 1001 한자는 NFC 기준 4,622자 중 4,619자 포함. U+9699·U+90CE·U+96B8 은 원본에 없다.
  - MuPDF 1.28.1 에서 공백류를 뺀 16,564 코드 포인트의 gid → 구조화 텍스트 추출 왕복 불일치 0. 기존 테스트 강제 실행 24/24 통과.
  - 뺀 코드 포인트가 입력되고 원본 폰트에도 없으면 `glyph-missing` 이다(U+00A0 은 입력 정규화에서 공백으로 바뀐다).

## 3. 좌표·단위

- M1 계약 2절 그대로: 기하는 페이지 공간(원점 왼쪽 위, y 아래, pt). 리플로우도 페이지 공간에서 한다.
- 쓰기(pdf-ops): 페이지 공간 → 사용자 공간(`userToPage` 역행렬). 편집 블록 `/Matrix` 가 삽입점 CTM 을 상쇄한다(D3).
- 텍스트 위치는 UTF-16 위치(`TextRun.text` 를 이은 문자열 기준). 클러스터는 확장 자소 단위(`Intl.Segmenter`, granularity grapheme)다.

## 4. 타입(packages/shared-types/src)

| 파일 | 내용 |
| --- | --- |
| `edit.ts`(새) | `ParagraphTarget`, `RunStyle`·`TextRun`, `ParagraphFormat`·`OverflowChoice`, `ReplaceParagraphOp`·`EditOp`, `PARAGRAPH_LIMIT_REASONS`·`ParagraphLimit`, `REMOVE_SKIP_CODES`, `EditWarning`, `InsertionInfo`, `ParagraphEditPlan`, `ParagraphEditability`·`PageEditability`, `PlacedGlyph`·`PlacedLine`·`ReflowSummary`, `DraftInput`·`DraftUpdate`·`BeginEditResult`, `EditHistoryState`(`revision`·`activeEditIds`), `CommitResult`, `EditedBlock`·`PageEditInfo` |
| `rpc.ts` | `RenderRequest.clip`, `RenderedPage.clip`, `PdfWorkerApi` 편집 메서드(아래) |
| `save.ts` | `SavePlan.edits`(편집 쪽·구조 연결이 끊긴 문단 수, 5.8) |
| `source-map.ts` | S1 이 채우는 선택 필드: `TextShowInfo.tlm`, `SourceOp.state`(채움 색 연산·ExtGState 연산·직사각형 클립), `SourceOp.markedContent`(열린 MC 의 연산·태그·MCID·ActualText 여부). 판정 예산(5.1) 안에서 한 번의 해석으로 얻기 위함 |

`PdfWorkerApi` 추가 메서드

| 메서드 | 동작 |
| --- | --- |
| `getPageEditability(pageIndex)` | 쪽의 흐름 문단마다 편집 가능 여부·사유(마우스 오버 표시용 일괄 판정) |
| `planParagraphEdit(pageIndex, paragraphId)` | 편집 가능 판정·시작 텍스트·모양·영역. 문서를 바꾸지 않는다. 결과에 `revision` |
| `getPageEdits(pageIndex)` | 이 쪽의 편집 블록 |
| `beginParagraphEdit(pageIndex, paragraphId, revision)` | `revision` 이 현재와 다르면 예외(오래된 문단 id 방지). 저널 작업을 열고 제거·삽입을 적용한 초안을 만든다. 편집할 수 없으면 예외 |
| `updateParagraphDraft(draftId, input)` | 리플로우 → 편집 블록 교체 → 변경 영역 렌더 |
| `commitParagraphEdit(draftId)` | 저널 작업을 닫고 `EditOp` 를 로그에 넣는다. 쪽 캐시 무효화(5.7) |
| `cancelParagraphEdit(draftId)` | `abandonOperation` 으로 되돌린다 |
| `undo()`·`redo()`·`getEditHistory()` | 문서 단위 undo/redo, 영향 쪽·`revision`·`activeEditIds` |
| `replayEdits(ops)` | 새로 연 문서에 로그를 다시 적용(복구, D6) |

- 연결부(계약 커밋): core 의 새 RPC 는 "M3 미구현" 예외. 뷰어는 기존 규칙(`failure.ts`)대로 "미구현" 이면 그 기능만 끈다.

## 5. 단계별 규칙

### 5.1 편집 대상과 편집 가능 판정(pdf-ops `planParagraphEdit`)

- 대상: `LayoutParagraph` 중 `table`·`figure` 가 null 이고, 모든 줄의 `dir` 이 (1, 0) 에서 0.5° 안이고 `wmode` 0 인 문단. 역할은 묻지 않는다(머리·꼬리 포함). 편집 블록 글자를 포함하면 대상은 그 블록(D3).
- 편집 제한(하나라도 있으면 편집 불가, 사유와 해당 글자 표시):

| 사유 | 조건 |
| --- | --- |
| `not-flow-paragraph` | 표 셀(M4)·도형 라벨 |
| `vertical-or-rotated` | 세로쓰기·회전 줄 |
| 연산 `limits` | 문단 글자 연산의 `unmatched`·`tokenizer-error`·`spans-stream-boundary`·`form-inherits-resources`(L1)·`outside-page-content`(L4)·`form-depth-exceeded`(L5)·`type3-font`·`font-encoding-unresolved`·`clip-text`·`invisible-text`(스캔 OCR 층 보호)·`inline-image`. `optional-content`(L7)는 경고만, `tagged-content`(L2)는 D1 |
| `remove-skipped` | 제거가 건너뛸 연산 포함(`ParagraphLimit.code`) |
| `mixed-content-sources` | 문단 글자가 쪽 콘텐츠와 Form 에 걸치거나 서로 다른 Form 사용 경로에 걸침 |
| `actualtext-partial` | D1 |
| `singular-ctm`·`insertion-clipped`·`bt-split-unsupported`·`graphics-state-mismatch` | D3 |

- 경고(편집은 가능): `font-fallback`, `glyph-missing`, `synthetic-style`, `tagged-structure-kept`, `tagged-structure-unlinked`, `actualtext-cleared`, `reading-order-approximate`, `link-overlap`, `redact-overlap`(A2-2, `assessRedactionImpact` 를 SourceMap 제거 기준으로 고친 판정), `optional-content`, `area-overlaps-content`, `overflow-clipped`.
- 판정 시간: 쪽 SourceMap·레이아웃 캐시가 있을 때 문단 하나 10 ms 이하, `getPageEditability` 쪽 하나 100 ms 이하(서버 Node, 측정 기록).

### 5.2 제거(pdf-ops)

- D2 그대로. 제거와 삽입은 한 번에 적용하고, 어느 하나가 실패하면 그 저널 작업을 버린다.
- 재편집(대상이 편집 블록): 원 연산 제거 없이 편집 블록 스트림만 다시 쓴다.
- 결과로 바뀐 객체 번호 목록을 돌려준다(테스트에서 객체 diff 기대값으로 쓴다).

### 5.3 시작 상태(편집기 초기값)

- 원 문단
  - 텍스트 = `LayoutParagraph.text`(M2 계약 2.3: 줄 안 `spaceAfter` 공백, 줄 사이 공백 하나, 줄 끝 "-" 는 붙임). 줄 끝 하이픈은 그대로 둔다.
  - `charIndexOfOffset[k]` = 텍스트 위치 k 의 `PageModel.chars` 인덱스, 합성 공백은 -1. 클릭 위치 → 캐럿 변환에 쓴다.
  - 모양 구간 = `styleRuns` 를 텍스트 위치로 옮긴 것. 합성 공백은 앞 구간에 붙인다. `RunStyle.sourceChar` = 그 구간 첫 글자의 `PageModel.chars` 인덱스.
  - `firstBaselineOffset` = 원 문단 첫 줄 기준선 − bbox 위쪽.
- 편집 블록(같은 세션): 그 블록의 마지막 `EditOp` 의 `runs`·`format`.
- 편집 블록(재열기 뒤 새 세션): `/PdfEditorFormat` 의 `runs`·`format`. 단, 블록에서 추출한 텍스트와 `runs` 텍스트가 공백류를 지우고 비교해 다르면 추출 텍스트 + 블록 bbox 로 시작한다(다른 도구가 고친 경우). `sourceChar` 는 블록 안 해당 구간 첫 글자의 현재 `PageModel.chars` 인덱스로 다시 정한다.

### 5.4 리플로우(reflow `layoutParagraph`)

입력: 글자별 폰트가 정해진 구간(pdf-ops FontManager 결과), `ParagraphFormat`, `areaLimit`. 출력: `ReflowSummary` + 쓰기용 글리프 목록.

| 항목 | 규칙 |
| --- | --- |
| 영역 | 기본 = 원 문단 bbox. 사용자가 핸들로 바꾼다 |
| 영역 상한 `areaLimit` | CropBox ∩ 사용 경로의 모든 Form BBox(중첩 포함) ∩ 삽입점의 직사각형 클립, 페이지 공간(A7-4). 영역이 상한을 넘으면 상한으로 자른다 |
| 줄 폭 | 영역 가로. 첫 줄은 `firstLineIndent` 만큼 줄인다(음수면 나머지 줄을 줄인다) |
| 기준선 | 첫 줄 기준선 = 영역 위쪽 + `firstBaselineOffset` × s. 줄 간격 = `lineHeight` × s(s = 글자 크기 배율). 원 문단이 한 줄이면 `lineHeight` = 글자 크기 × 1.2 |
| 줄 나눔 기회 | 공백 뒤, 하이픈·대시 뒤, CJK 표의문자 사이. 한글은 어절(공백) 우선, 어절이 줄 폭보다 길면 음절 단위. 라틴 단어가 줄 폭보다 길면 글자 단위. 강제 줄바꿈 `\n` |
| 금칙 | 줄 머리 금지 `. , : ; ! ? ) ] } 」 』 〉 》 ’ ” % … · ）` 등, 줄 끝 금지 `( [ { 「 『 〈 《 ‘ “ （` 등(구현 표는 reflow 문서에 고정) |
| 정렬 | left·right·center·justify(`unknown` 은 left). justify 는 마지막 줄·강제 줄바꿈 앞 줄을 빼고 단어 사이 TJ 조정으로 늘린다. 공백이 없는 줄(CJK)은 클러스터 사이에 고르게 나눈다. Tw 는 쓰지 않는다(멀티바이트 코드에는 적용되지 않음, 9.3.3) |
| 줄 끝 공백 | 폭 계산에서 뺀다. 쓰기는 줄 끝 공백 글리프를 남겨 추출 시 단어가 붙지 않게 한다 |
| 폰트 없는 글자 | `glyph-missing` 클러스터는 배치하지 않는다(폭 0, 쓰지 않음) |
| 초과 | 마지막 줄 아래(기준선 + 하강)가 영역 아래 + 0.5pt 를 넘으면 초과. 가로 초과는 글자 단위 나눔으로 생기지 않는다 |
| 축소(`shrink`) | 0.8 ≤ s ≤ 1 에서 들어가는 가장 큰 s(0.01 단위). 0.8 에서도 넘치면 s = 0.8 + 초과 표시 유지. s 는 출력(`ReflowSummary.fontScale`)이고 입력이 아니다 |
| 넓히기(`expand`) | 필요한 높이만큼 영역 아래 변을 내린다(상한까지). 상한에 막히면 초과 표시 유지 |
| 그대로(`keep`) | 넘친 줄도 그대로 쓴다(자동 클립 없음). `areaLimit` 밖으로 나간 부분은 CropBox·상위 Form BBox 에서 잘리므로 경고 `overflow-clipped` |
| 줄 | 빈 텍스트도 줄 1개(캐럿용). 빈 `TextRun` 은 모양을 유지하기 위해 남긴다 |
| 결정성 | 같은 입력이면 같은 결과(D6 재적용) |

### 5.5 쓰기(pdf-ops `writeEditBlock`)

- 블록 스트림: `q` → 텍스트 상태 명시(`0 Tc 0 Tw 100 Tz 0 TL 0 Ts`, `Tr` 은 0·합성 굵게 2·원 글자 Tr 1/2 를 따름) → 필요하면 `gs` → `BT` → 줄마다 `Tm` 절대 위치, 폰트가 바뀌면 `Tf`, 글자는 `TJ`(커닝·정렬 조정 숫자 포함) → `ET` → `Q`.
- 채움 색: `sourceChar` 연산 시점의 채움 색 연산을 원래 색공간 그대로 쓴다(색공간 리소스는 블록 Resources 로 복사).
- 문자열: 원본 폰트는 그 폰트의 코드(1바이트 또는 CMap 바이트), 폴백 폰트는 2바이트 gid. 16진 문자열.
- 전진량: 원본 폰트는 명세 폭 그대로(위치 차이만 TJ 숫자), 폴백 폰트는 `/W` 와 셰이퍼 결과의 차이를 TJ 숫자로 보정한다. 숫자는 위치 차이(페이지 공간)를 1/1000 텍스트 공간 단위로 환산한다.
- 블록 사전 키(`/PdfEditorEdit`·`/PdfEditorFormat`)는 D3.
- 기존 `serializeTextBlock`(M0, Identity-H 전용)은 스파이크 호환을 위해 남기고 M3 쓰기는 새 함수로 한다.

### 5.6 저장 메타

- 저장 때 Info `/PdfEditorEdits` = `"pages=<1부터 쪽 번호 목록>; structure=not-updated|n/a"`(D1). 이미 있으면 쪽 번호를 합집합으로 합친다. `/ModDate` 갱신, `/Producer` 는 바꾸지 않는다.
- XMP `ModifyDate` 는 갱신하지 않는다(불일치는 기록만). `/Metadata` 에 PDF/A 선언이 있으면 저장 전 "PDF/A 적합성이 깨질 수 있음" 경고.
- 편집 쪽 번호가 파일에 남는다는 사실을 설정·도움말에 적는다.

### 5.7 세션 상태(core)

- 문서 1개당 초안은 최대 1개. 초안이 있는 동안 렌더·추출·검색은 허용(초안 상태 기준, D7), 다른 편집 RPC 와 `planSave`·`save` 는 예외.
- 커밋 시 그 쪽의 추출·SourceMap·레이아웃 캐시를 무효화한다. 이웃 쪽 레이아웃(머리·꼬리 반복 판정, M2)도 무효화한다(±2쪽). `revision` 을 올린다.
- 편집 블록 목록(쪽별)은 undo/redo 뒤 `listEditBlocks` 로 다시 만든다.
- 폴백 폰트 바이트는 세션 생성 옵션의 비동기 로더(`loadFallbackFont`)로 첫 `getPageEditability`·`planParagraphEdit`·`beginParagraphEdit` 에서 await 한다. 저널은 첫 `beginParagraphEdit` 에서 켜고, 켜기 직전(작업 밖)에 Info 사전 생성(없을 때)과 폴백 폰트 `embedFont` 를 한 번 한다(수정 1). FontManager 에는 `FallbackFontSource`(바이트는 판정·셰이핑용, 객체 참조는 저널을 켠 뒤부터)로 넘긴다. 확장은 Worker 에서 `new URL('<번들 경로>', import.meta.url)` 로 받는다(전용 Worker 에서 chrome.* 사용 가능 여부는 S4 가 확인), Node 테스트는 `assets/fonts` 파일을 읽는다.

### 5.8 저장(core·뷰어)

- 저장 전 `planSave` → `warn` 이면 확인 창, `over-limit` 이면 중단 안내(A3-2).
- 저장 중 Worker 예외 → D6 복구 후 사용자에게 다시 저장할지 묻는다(A3-3). 실패 주입 테스트로 고정한다.
- 태그 쪽 편집이 있고 구조 연결이 끊긴 문단이 있으면 저장 전 경고(`SavePlan.edits.structureUnlinked`).

### 5.9 뷰어 편집기(viewer-ui·extension)

| 항목 | 규칙 |
| --- | --- |
| 진입 | 마우스가 문단 위에 있으면 테두리(`getPageEditability` 로 편집 가능·제한 색 구분). 더블클릭으로 편집 시작, 캐럿은 클릭한 글자 위치. 한 번 클릭·드래그는 기존 텍스트 선택 그대로(M1) |
| 제한 문단 | 더블클릭하면 사유를 팝오버로 보여 준다 |
| 입력 | 숨긴 `textarea` 에 포커스. `beforeinput`·`input`·`composition*` 로 편집 모델(텍스트·모양 구간·캐럿·선택)을 고친다. 입력·붙여넣기는 NFC 정규화, 붙여넣기는 텍스트만, 줄바꿈은 강제 줄바꿈 |
| 키 | 화살표(줄 이동은 리플로우 줄 기준), Home/End, Shift 선택, Ctrl+A(문단 안), Backspace/Delete, Enter(강제 줄바꿈), Ctrl+Z/Ctrl+Shift+Z·Ctrl+Y(편집 중 글자 단위) |
| 종료 | 바깥 클릭·Esc(조합 중이 아닐 때) → 커밋(변경 없으면 취소와 같음). 도구 막대 "편집 취소" → 취소. Esc = 커밋은 일반 관례(Esc = 취소)와 다르므로 사용자 확인 권고(D11) |
| 초과 UI | 영역 테두리와 초과 표시. 선택지: 영역 넓히기 / 글자 줄이기(최소 80%) / 그대로 두기 |
| 영역 핸들 | 네 변·네 모서리. `areaLimit` 밖으로 못 나감. 다른 내용과 겹치면 경고 |
| 표시 | 폴백 글자 점선 밑줄(토글), 없는 글자 표시, 경고 목록, 태그 쪽 안내(D1) |
| 문서 undo | 편집 밖 Ctrl+Z/Ctrl+Shift+Z·Ctrl+Y, 도구 막대 버튼 |
| 저장 | 기존 Ctrl+S 흐름 + 5.8. 초안이 있으면 먼저 커밋 |
| 열기 시 | Redact 주석 보고(`listRedactAnnots` 쪽·개수, A2-2) |
| DNR 경로 | file:// 이고 파일 URL 접근이 꺼져 있으면 안내(A5-3, 128–149) |
| 복구 | 원본은 `open` 전에 `Blob` 으로 보관, 커밋된 `EditOp` 와 `activeEditIds` 보관(D6) |

## 6. 검증 전제와 작업 분할

### 6.1 검증 전제(어긋나면 해당 작업이 즉시 메인 세션에 보고한다. 계약을 임의로 바꾸지 않는다)

| # | 전제 | 확인 담당 |
| --- | --- | --- |
| V1 | MuPDF 저널이 편집 블록 Form 추가·스트림 교체·리소스 추가·폰트 추가를 undo/redo 로 되돌린다. 시나리오: 폴백을 넣은 초안 취소 뒤 새 편집, 폴백을 넣은 편집 undo 뒤 새 편집 → 저장, D9 저장 순서 뒤 undo/redo. 저널 메모리 증가량 기록. 재적용 결과와의 비교는 통합 단계 | core |
| V2 | 삽입점에 `q /<이름> Do Q` 를 끼워도 편집 영역 밖 렌더 0 px(세 엔진)이고, 재추출 순서에서 편집 블록 텍스트가 삽입점 자리에 온다(MuPDF stext 가 기하 근접으로 이웃 블록에 합치는지 포함) | pdf-ops |
| V3 | BT 나누기(`ET q … Q BT Tm [n] TJ`) 뒤 같은 BT 의 남은 글자 위치·모양이 그대로다(세 엔진 0 px, 소수 계수 Tm 포함) | pdf-ops |
| V4 | 원본 폰트 글리프 외곽선·폭 판정이 렌더 결과와 같다. 폴백 폰트 `embedFont` + `subsetFontBytes` 결과의 ToUnicode 로 pdf.js·Poppler 복사·검색이 된다(M0 는 MuPDF·Chrome 만 확인) | pdf-ops |
| V5 | MC 안에서 `Do` 로 부른 Form(MCID·/StructParents 없음)의 텍스트가 그 MC(MCID)의 내용으로 추출된다(pdf.js `includeMarkedContent`). ActualText 제거 뒤 세 엔진 복사 결과에 옛 텍스트가 없다 | pdf-ops |
| V6 | harfbuzzjs 1.6.2(`kern` 만)가 번들 Noto Sans KR 서브셋을 읽고, 글리프 전진량이 MuPDF `addFont` 의 `/W` 와 같다(1/1000 em 반올림 차이 허용). 모든 출력 gid 의 ToUnicode 왕복이 맞는다 | reflow |
| V7 | Playwright 번들 Chromium 에서 CDP `Input.imeSetComposition`·`Input.insertText` 로 composition 이벤트가 재현된다 | viewer-ui |
| V8 | 영역 렌더(clip) 시간이 편집 반응 예산(8.4) 안이다 | core |

### 6.2 작업 분할(패키지별 세션, 각자 worktree)

공통 규칙(M1 계약 5절과 같음)

- worktree: `git -C /mnt/nas4/kjune/pdf-editor worktree add /mnt/nas4/kjune/pdf-editor-m3-<작업> -b m3-<작업> m3` 후 `pnpm install --frozen-lockfile`.
- 허용 파일 밖을 바꿔야 하면 멈추고 메인 세션에 보고한다. 새 의존성, 메인 세션 전용 타입·시그니처 변경도 같다.
- 단계별 커밋, 커밋 메시지에 Claude 공동 저자 표기 금지, 원격 푸시 금지.
- 완료 기준 공통: 그 worktree 에서 `pnpm exec turbo run build typecheck test --force`, `pnpm lint`, 추적 파일 Prettier 통과. 결과는 `docs/m3-<작업>.md` 에 날짜·실측 표기로 남긴다.

| 작업 | 담당 모델 | 허용 파일 | 구현 | 보고 |
| --- | --- | --- | --- | --- |
| S1 pdf-ops | Opus 설계·리뷰 + Sonnet 구현 | `packages/pdf-ops/**`(내보낸 편집 시그니처 제외), `docs/m3-pdf-ops.md` | 인터프리터 선택 필드(4절 `source-map.ts`), 5.1 판정·`getPageEditability` 용 일괄 판정, D2 제거 확장(일부 연산·Form 바이트 복제·ActualText·건너뜀 코드·교체 목록 일괄 적용), D3 삽입, D4 FontManager(외곽선 판정·폴백 수명), 5.5 쓰기, 5.6 메타. 세 엔진 비교는 devDependency `pdfjs-dist`·시스템 Poppler | V2–V5, 판정 시간, 코퍼스 편집 가능 비율 |
| S2 reflow | Opus 설계 + Sonnet 구현 | `packages/reflow/**`(내보낸 타입 제외), `docs/m3-reflow.md` | 셰이퍼 인터페이스·단순 셰이퍼·harfbuzz 셰이퍼(`kern` 만), 5.4 전부. `/W` 비교는 devDependency `mupdf` | V6, 줄 나눔·금칙 표, 배치 시간 |
| S3 core | Sonnet 구현, 설계 판단 Opus | `packages/core/**`(`test/layout-accuracy*.ts` 제외), `docs/m3-core.md` | 편집 RPC 전부, 저널·로그·`revision`·`activeEditIds`·`replayEdits`, D9 저장 순서, 5.7 캐시·편집 블록, 영역 렌더, 5.8 저장·복구, 폴백 폰트 로더 | V1(전반)·V8 |
| S4 viewer-ui·extension | Sonnet | `packages/viewer-ui/**`, `apps/extension/**`(의존성 추가 제외), `docs/m3-viewer-ui.md` | 5.9 전부, 1.3 IME e2e, 확장 배포: Worker 번들에 `harfbuzz.wasm` 포함·폴백 TTF dist 복사·`apps/extension/src/worker/pdf-worker.ts` 에 `loadFallbackFont`(`exposePdfWorker` 두 번째 인자) | V7, 통합 시 켤 e2e 목록 |
| S5 레이아웃 보강(선택) | Sonnet | `packages/layout-recon/**`, `packages/core/test/layout-accuracy*.ts`, `docs/m2-accuracy.md` | W4-1 하네스 역할 채점, W4-4 nasa-eo 11쪽 문단 경계 회귀 원인(dev 로만 조정) | 역할 일치율, 회귀 원인 |

- S1·S2·S4·S5 는 독립. S3 은 pdf-ops·reflow 함수의 고정 시그니처(계약 커밋의 연결부)에 맞춰 병렬로 진행한다. 실제 연결·재적용 결정성·V1 후반은 통합에서 한다.

## 7. 통합 순서

1. S1·S2 를 메인 세션이 사용자 승인 후 `m3` 에 머지 → S3 → S4(S5 는 언제든).
2. 통합 테스트: 1.1 흐름 Playwright, IME e2e, 실패 주입, 재적용 결정성, V1 후반.
3. 코퍼스 편집 측정(8.2)과 편집 가능 비율 보고.
4. 마일스톤 리뷰(구현 맥락과 분리한 읽기 전용 세션) → 사용자 승인 후 `m3` 를 `main` 에 머지.
5. Windows 사용자 확인: MS 한글 IME 실제 입력·한자 변환, 편집 문서 Ctrl+S 덮어쓰기(A10), 저장 파일의 Acrobat Reader 표시(설치 시).

## 8. 측정

### 8.1 단위·합성

- 각 작업이 합성 PDF 로 고정한다.
  - 일부 연산 제거(Tj·TJ·'·"), BT 나누기(소수 계수 Tm, Tr 4–7 있는 BT), MC·BMC·ActualText.
  - 공유 스트림, Form 복제(`/StructParents` 포함), 특이 CTM·y 반전 CTM·클립.
  - 앞선 BT 가 Tr 3 을 남긴 경우, `/Rotate` 90·270.
  - 폰트 역매핑(Type1·TrueType·Type0), 외곽선만 비운 서브셋 글리프, 폭 0 코드, 폴백 섞인 줄, 폰트 없는 글자.

### 8.2 코퍼스 편집 표본

- 문서마다 쪽 2개(1·4쪽, 없으면 있는 쪽). 쪽마다 읽기 순서상 앞에서부터 편집 가능하고 20자 이상인 흐름 문단 최대 3개(M1 A7-2 표본 방식).
- 편집 3종
  - (i) 같은 텍스트로 교체.
  - (ii) 라틴 문장 바꾸기: 고정 단어 목록에서 문서 id 를 시드로 만든 문장, 원 길이 ±30%.
  - (iii) 원본에 없는 한글 문장 추가: 고정 문장 목록.
- 측정: 1.1 의 시각·새 글자·텍스트·검색·순서·객체, 편집 가능 비율·사유, 저장 시간·힙.
- 실행은 환경 변수가 있을 때만(`EDIT_CORPUS_DIR`, 결과 `EDIT_CORPUS_OUT`). 결과 JSON 은 git 밖.

### 8.3 판정 정의

| 항목 | 정의 |
| --- | --- |
| 렌더 | scale 2, 주석 제외, 채널 차 8 초과 픽셀 수. MuPDF·pdf.js(pdfjs-dist 6.4.299)·Poppler(pdftoppm) |
| 변경 허용 영역 | 원 문단 bbox ∪ 최종 배치 상자(`contentBox`) ∪ 지운 글리프 잉크 상자, 여백 2pt. 잉크 상자 = 원본에서 지운 글리프만 그린 렌더의 잉크 외접 상자 |
| 텍스트 | 추출기: MuPDF 구조화 텍스트, pdf.js `getTextContent`. 편집 블록 출처 글자(블록 상자 안의 글자)만 모아 양쪽 모두 공백류를 지운 문자열이 같다. 공백 접기 비교(줄바꿈 → 공백)는 보조 지표로 기록만 |
| 순서 | 같은 엔진으로 원본에서 추출한 순서 기준. 원 문단의 직전·직후 문단(PageLayout 읽기 순서 이웃)의 마지막·첫 글자 위치를 편집본 추출에서 찾아, 직전 마지막 < 새 첫 글자, 새 마지막 < 직후 첫 글자 |

### 8.4 성능 측정

- 모집단: 고정 문단 10개(코퍼스 5문서 × 2, 500자 이하)에 고정 텍스트 3종을 스크립트로 입력할 때의 키 입력 전부.
- 구간: 입력 이벤트 → 변경 영역 합성 완료(뷰어 `performance.mark`).
- 환경: 서버 Playwright 번들 Chromium, 뷰어 scale 1.5, devicePixelRatio 1.

## 9. PLAN.md 반영(v2.11, 2026-10-19 적용)

- 1.4: D1 세부(MCID 유지 시도, ActualText, Info 기록, 설정, Form 복제본 /StructParents).
- 2절 셰이핑 행: D5(원본 폰트는 명세 폭, harfbuzz 는 폴백 폰트에 `kern` 만).
- 2절 한글 폴백 폰트 행: D12 결과.
- 3.1: redaction 대체 경로를 M3 편집에서 쓰지 않음(D2), 저장과 저널(D9), 재저장 기준(A3-9).
- 3.2: 저널 + 로그 + 복구(D6).
- 3.3: 글자 단위 폴백, 외곽선·폭 판정, 폴백 수명, 합성 굵게·기울임, `glyph-missing`(D4).
- 3.4: Form 안 텍스트는 바이트 복제 + SourceMap 제거, `redactFormUsage` 대체 경로 문구 삭제(D2).
- 4절 데이터 흐름: `pdf-ops.plan → FontManager → reflow → pdf-ops.write(편집 블록)`.
- 6절 M3 행: 1.1 DoD 요약.

## 10. 계약 변경 절차

- 작업 세션은 계약 불일치를 발견하면 구현을 멈추고 근거(재현 코드·수치)와 제안을 메인 세션에 보고한다.
- 메인 세션이 `m3` 에서 계약을 고치고 커밋한 뒤, 각 작업 브랜치가 `m3` 을 머지해 따라간다.

## 11. 계약 작성 중 실측(2026-10-19, 서버 Node 22.18, mupdf 1.28.1)

독립 검토가 만든 탐침 스크립트(저장소 밖)를 메인 세션이 다시 실행해 확인했다.

| 항목 | 결과 |
| --- | --- |
| 저널 + 저장 옵션 | `garbage=yes,compress`·`compress`: 저장이 저널 단계를 만들지 않음. `garbage=yes,compress,objstms`: 저장마다 "Save document" 단계 추가, 저장 직후 첫 undo 무효("Edited" 그대로), 두 번째 undo 에서 원상태. `garbage=compact,compress`: undo 뒤에도 "Edited", 다시 저장해도 "Edited" |
| 작업 중 저장 | 성공하고 초안 텍스트가 파일에 들어감. 작업 중 `canUndo()` 예외 `Can't undo/redo during an operation`. `abandonOperation` 뒤 원상태 |
| 감싼 저장 | `beginOperation` → Info 기록 → `saveToBuffer('garbage=yes,compress,objstms')` → `abandonOperation`: 출력에 반영, 저널 `[edit]` 유지, undo/redo 정상. 단, 그 작업에서 새로 만든 Info 객체는 버린 뒤 trailer 에서 끊긴 참조(`cannot find object in xref`) |
| 작업 안 폰트 추가 후 버림 | 그 폰트 객체가 xref 에서 사라짐(`cannot find object in xref (5 0 R)`), 이후 그 참조로 쓰기 실패 |
| 렌더·구조화 텍스트 | 저널 단계를 만들지 않음 |
| harfbuzzjs 1.6.2 기본 기능 | `한글 fi` → gid 11293,1217,1,11878(fi 합자), 언어 ko 이면 공백 → 12084(폭 280, cmap 공백은 224). `——` → 445 |
| 합자 gid 추출 | MuPDF `addFont` 로 넣은 폰트에서 gid 11878 을 그리면 추출 결과 `��`(ToUnicode 에 없음) |
| 폴백 범위 | 이전 번들 서브셋 cmap 12,005자, 한자 0, €·™·U+1100 자모 없음. KS X 1001 한자·€·™ 추가 시 4,083,596 B(시스템 fontTools 4.61.1 측정, 고정 버전 4.62.1 재생성 결과와 같은 크기) |
