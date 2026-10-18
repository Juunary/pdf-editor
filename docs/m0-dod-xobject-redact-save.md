# M0 DoD 잔여 항목: 공유 Form XObject · 기존 Redact 주석 · 대형 문서 저장 상한

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-18 |
| 범위 | PLAN.md 6절 M0 DoD 중 서버에서 가능한 잔여 항목. `docs/m0-day1-log.md` 8절 A4·A6 |
| 수행 위치 | Mustree 서버 `sailab01` `/mnt/nas4/kjune/pdf-editor` (AMD Ryzen 9 5950X 32스레드, Node v22.18.0, mupdf 1.28.1, Poppler 22.02.0) |
| 측정 표기 | 이 문서의 수치는 모두 **실측 2026-10-18**, 서버(Node) 기준. Windows Chrome 수치 아님 |
| PLAN.md | 수정하지 않음. 변경 필요 사항은 각 절 끝 "PLAN.md 반영 필요" 에 적는다 |

## 0. 판정 요약

| # | 항목 | 판정 | 근거 수치 |
|---|---|---|---|
| 1 | 공유 Form XObject: 선택 사용 위치만 복제 후 수정(중첩 1단계 포함) | **통과**(v1 제한 조건 7가지, 1.6) | 3가지 편집 모두 비선택 위치·2쪽 렌더 diff 0 px(MuPDF·Poppler), 원본 객체 중 변경은 1쪽 페이지 사전 1개, 2쪽 객체 트리 저장 후 원시 바이트 동일 |
| 2 | 기존 Redact 주석이 있는 문서: 새 편집 redaction 만 적용, 기존 주석 유지 | **통과**(정책 초안: 기본 경고, 페이지 단위 작업 시 임시 분리) | 기존 주석 3개 객체 불변·저장 후 위치·OverlayText 동일, 그 아래 텍스트 유지(MuPDF·Poppler), 편집 영역 밖·2쪽 0 px. 대조: 페이지 단위 적용은 기존 2개를 적용해 인접 문단 삭제(9,874 px) |

## 1. 공유 Form XObject 복제 정책

### 1.1 픽스처

`fixtures/m0/m0-shared-xobject.pdf` (2,091 B, sha256 `a035cf22…4ca3`). 생성: `tools/spike-m0/src/fixture-xobject.ts`, 재생성 `pnpm --filter @pdf-editor/spike-m0 fixtures`(두 번 실행해 같은 해시 확인).

| 객체 | 내용 |
|---|---|
| Fx1 (카드, BBox 0 0 483 200) | 배경·테두리·가로/세로 괘선, 제목(Helvetica-Bold 14), 교체 대상 문단 3줄(Helvetica 11, 세로 괘선이 가로지름), 중첩 Fx2 1곳 |
| Fx2 (배지, BBox 0 0 150 44) | 배경·테두리, 2줄(Helvetica 9, 중첩 교체 대상) |
| 1쪽 | Fx1 을 A(y=540)·B(y=300) 두 곳에서 그림 + 제목·꼬리말 |
| 2쪽 | Fx1 을 C(y=540)·D(0.8배, y=300) 두 곳 + Fx2 직접 1곳(E) + 꼬리말 |
| Resources | 두 페이지가 간접 객체 1개를 공유 |

사용 위치 수(문서 전체): Fx1 4곳, Fx2 5곳(Fx1 안 4 + 직접 1).

### 1.2 구현

| 구성 | 위치 | 내용 |
|---|---|---|
| 콘텐츠 스트림 토크나이저 | `packages/pdf-ops/src/content-stream.ts` | 연산자 단위 분리·바이트 범위, 문자열(중첩 괄호·이스케이프)·16진 문자열·배열·사전·주석·이름 `#xx`, 인라인 이미지(BI…ID…EI) 건너뛰기. M1 인터프리터(PLAN.md 3.4) 기반 |
| 사용 위치 색인 | `packages/pdf-ops/src/xobject.ts` `listXObjectUsages` / `indexXObjectUsages` | q/Q/cm 로 CTM 추적, Form `/Matrix` 반영, Form 재귀(깊이 상한 8, 순환 방지). 사용 위치마다 Do 체인(리소스 이름, Do 순번, 이름 피연산자 바이트 범위, CTM)·페이지 공간 BBox |
| 선택 위치 복제 + 텍스트 제거 | `redactFormUsage` | 아래 방식 |
| 인스턴스에 새 문단 | `addFontResource`(Form 전용 Resources 사본에 폰트 등록), `appendFormContent`(원 콘텐츠 `q … Q` 감싸고 뒤에 추가), `outsideFormBBox` | Form 공간 좌표로 배치 |

`redactFormUsage` 방식:

1. 원 페이지와 같은 MediaBox·CropBox·Rotate·UserUnit 의 임시 페이지를 문서 끝에 넣고, 선택 사용 위치의 최상위 Form 을 같은 CTM 으로 그린다(`q <CTM> cm /X Do Q`).
2. 임시 페이지에서 Redact 주석을 만들고 주석 단위 `applyRedaction`(텍스트 제거, 선화·이미지 보존)을 적용한다. MuPDF 는 Form 마다 필터링한 새 인스턴스를 만들고 원본 Form 은 고치지 않는다(1.3).
3. 그 인스턴스를 원 페이지의 선택 Do 1곳에만 연결한다: 페이지 Resources 를 페이지 전용 사본으로 바꾸고 새 이름(`FxE0`…)을 등록, 페이지 콘텐츠에서 해당 Do 의 이름 피연산자 바이트만 바꾼 새 스트림 객체로 교체.
4. 임시 페이지를 지운다(남은 객체는 전체 저장 `garbage=compact` 에서 제거).
5. 중첩 경로면 인스턴스 체인에서 Do 순번으로 하위 인스턴스를 찾아 편집 대상으로 돌려준다.

정책 귀결: 편집하는 사용 위치는 공유 여부와 무관하게 항상 새 인스턴스로 바꾼다. 공유되지 않은 원본은 참조가 없어져 전체 저장에서 제거되므로 별도 분기가 필요 없다. 중첩 사용 위치를 편집하면 상위 체인(선택 위치의 Fx1)도 새 인스턴스가 된다.

### 1.3 MuPDF 기본 동작(대조): 페이지 redaction 의 Form 처리

Day 1 경로(`redactRegions` = 페이지에 Redact 주석 생성 후 주석 단위 적용)로 1쪽 B 의 문단 영역을 지운 결과:

| 관찰 | 값 |
|---|---|
| 새 Form 객체 | **4개**: 1쪽이 쓰는 모든 Form 사용 위치(A, A/Fx2, B, B/Fx2)마다 인스턴스(`Fm1`, `Fm2`…) |
| 1쪽 비선택 위치 A | 원본 Fx1 이 아닌 새 인스턴스를 가리킴(렌더는 동일, 0 px) |
| 1쪽 콘텐츠 | 전체 재직렬화(201 → 192 B) |
| 2쪽·원본 Fx1·Fx2·공유 Resources | 변경 없음(2쪽 객체 트리 저장 후 원시 바이트 동일) |

- MuPDF 1.28.1 redaction 은 Form 을 재귀 필터링하며 원본을 고치지 않고 사용 위치별 인스턴스를 만든다. 따라서 다른 페이지는 기본 경로에서도 안전하다.
- 같은 페이지의 편집하지 않은 Form 사용 위치까지 인스턴스화·재직렬화되므로 "나머지 위치 바이트 불변" 은 만족하지 못한다 → 1.2 의 임시 페이지 방식을 쓴다.
- 이 동작은 Form 이 있는 페이지에서 페이지 콘텐츠 텍스트를 직접 편집할 때(Day 1 경로)도 같다 → 1.7 A1-1.

### 1.4 결과

실행: `pnpm --filter @pdf-editor/spike-m0 spike:xobject` → `out/m0-dod/xobject-result.json`(git 제외). 렌더는 MuPDF scale 2(1190×1684 px), Poppler `pdftoppm` 108 dpi. 교체 텍스트는 폴백 폰트(Noto Sans KR glyf TTF 서브셋) 한글.

| 경우 | 내용 |
|---|---|
| depth1 | 1쪽 B 의 Fx1 문단 3줄 → 한글 2줄(11pt) |
| depth2 | 1쪽 B 안의 중첩 Fx2 2줄 → 한글 1줄(9pt) |
| sequential | depth1 후 같은 B 에서 depth2(이미 인스턴스화된 위치 재편집) |
| 대조 | 1.3 페이지 redaction |

| 측정 | depth1 | depth2 | sequential | 대조 |
|---|---|---|---|---|
| 편집 전 대상 원본 사용 위치 수 | Fx1 4 | Fx2 5 | 4 → 1(두 번째 편집 시) | Fx1 4 |
| 새 Form 객체 | 2 | 2 | 2 + 2 | 4 |
| 원본 객체 중 변경 | 1쪽 페이지 사전 1개 | 동일 | 동일 | 동일 |
| 1쪽 콘텐츠 변경 | `/Fx1` → `/FxE0` (201 → 202 B) | 동일 | `/Fx1` → `/FxE1` | 전체 재직렬화 |
| 원본 객체를 계속 가리키는 사용 위치 | A, A/Fx2, C, C/Fx2, D, D/Fx2, E | 동일 | 동일 | C, C/Fx2, D, D/Fx2, E |
| 제거 직후 1쪽 vs 기대 페이지(대상만 없음) | 0 px | 0 px | 0 px | 0 px |
| 1쪽 선택 위치 밖 vs 원본 | 0 px | 0 px | 0 px | 0 px |
| 2쪽 vs 원본 | 0 px | 0 px | 0 px | 0 px |
| 저장 전·재열기 1쪽 vs 참조 렌더 | 0 / 0 px (참조 잉크 8,785 px) | 0 / 0 px (9,852) | 0 / 0 px (8,075) | 해당 없음 |
| 재열기 텍스트 | 새 문단 1회, 원 문단 1회(A) | 새 배지 1회, 원 배지 1회(A) | 새 문단·배지 각 1회 | 원 문단 1회 |
| 2쪽 객체 트리(번호 무관) 저장 후 | 디코드·원시 바이트 동일 | 동일 | 동일 | 동일 |
| Poppler 2쪽 / 1쪽 선택 위치 밖 | 0 / 0 px, 2쪽 텍스트 동일, 새 텍스트 검출 | 동일 | 동일 | 0 / 0 px |
| redaction(인스턴스화) 시간 | 3.4 ms | 2.8 ms | 6.8 + 1.7 ms | 4.6 ms |
| 저장 | 전체, 10,960 B, subset 4.6 + save 0.9 ms | 전체, 8,211 B | 전체, 12,361 B | 전체, 3,558 B |
| MuPDF 경고·오류 | 0 | 0 | 0 | 0 |

- "참조 렌더" = 기대 페이지 위에 폰트 파일에서 직접 그린 글리프(Form→페이지 행렬 적용). 0 px 는 인스턴스 안 새 텍스트가 의도한 위치·모양으로 그려졌다는 뜻이다.
- 고정 결과 파일: `fixtures/m0/m0-shared-xobject-edited.pdf`(sequential, 12,361 B, sha256 `308f573e…5dc`). 재생성 시 같은 해시.
- 자동 테스트: `packages/pdf-ops/test/xobject.test.ts`(5건, 소형 문서), `packages/pdf-ops/test/content-stream.test.ts`(4건), `tools/spike-m0/test/xobject.test.ts`(5건, 위 표의 판정 조건).

### 1.5 함께 고친 결함

| 결함 | 영향 | 조치 |
|---|---|---|
| `ownPageResources` 가 페이지 자체 Resources 가 간접 객체(여러 페이지 공유)일 때 그 공유 객체를 그대로 돌려줌 | `addPageFontResource` 가 다른 페이지의 Resources 까지 고침(바이트 변경) | 간접·상속·직접 모두 페이지 전용 사본으로 교체(`ownResources`) |
| 사본을 만들 때 직접 하위 사전(Font·XObject)을 `put` 으로 옮기면 MuPDF 는 같은 객체를 공유함 | 사본의 하위 사전을 고치면 원본도 바뀜(테스트에서 공유 Resources 변경으로 발견) | 직접 객체는 재귀 복사, 간접 참조만 유지(`copyDirect`). 회귀 테스트 `text-ops.test.ts` 1건 추가 |

Day 1 고정 파일(`m0-sample.pdf` `913c521a…`, `m0-spike-saved.pdf` `58b19a53…`)은 수정 후 재생성해도 해시가 같다.

### 1.6 v1 편집 제한 판정 기준

통과 판정은 1.1 구조에 대한 것이다. 아래 조건의 Form 사용 위치는 v1 에서 "편집 제한" 으로 판정하고 사유를 표시한다.

| # | 조건 | 사유 | 근거 |
|---|---|---|---|
| L1 | Form 에 자체 `/Resources` 가 없음(페이지 리소스 상속, PDF 1.2 이전 관행) | 인스턴스의 Resources 가 빈 사전이 되어 폰트 참조가 끊긴다 | 실측: 인스턴스 사전 `/Resources<<>>`, 콘텐츠는 `/F1` 사용 |
| L2 | Form 또는 내부에 `/StructParents`·MCID(태그 PDF) | 인스턴스가 `/StructParents` 를 그대로 복사해 구조 트리 참조가 중복된다 | 실측: 인스턴스 사전에 `/StructParents 7` 유지. PLAN.md 1.4 태그 정책(경고 + 편집 제한 옵션)으로 처리 |
| L3 | 새 텍스트가 Form BBox 를 벗어남 | Form 은 BBox 로 잘리므로 자동 클립 금지(PLAN.md 1.3)와 충돌 | `outsideFormBBox` 로 판정. 인스턴스 BBox 확장은 미구현 |
| L4 | Form 이 페이지 콘텐츠 밖에서 쓰임(주석 외관 AP, 타일링 패턴, Type3 글리프, SMask) | 사용 위치 색인 대상이 아니다 | 구현 범위 |
| L5 | Form 재귀 깊이 > 8 또는 순환 참조 | 색인 중단 | 구현 상한 |
| L6 | 토크나이저 실패(닫히지 않은 문자열, 인라인 이미지 데이터 안의 우연한 `EI` 등) 또는 이름 피연산자가 Contents 배열의 스트림 경계에 걸침 | 원본 바이트 위치를 특정할 수 없다 | 예외 → 편집 불가 |
| L7 | `/OC`(선택적 콘텐츠) Form | 인스턴스가 `/OC` 를 복사하므로 표시 상태는 유지되나 레이어 UI 연동은 미검증 | 실측: `/OC` 참조 유지. 경고만 표시 |

### 1.7 문제·Action Items(1번 항목)

| # | 내용 | 시점 |
|---|---|---|
| A1-1 | Form 이 있는 페이지에서 페이지 콘텐츠 텍스트를 직접 편집하면(Day 1 경로) 그 페이지의 모든 Form 사용 위치가 인스턴스화·재직렬화된다(1.3). redaction 영역과 겹치지 않는 사용 위치를 원본 객체로 되돌리는 후처리(페이지 공간 BBox 비교) 또는 같은 임시 페이지 방식 적용을 M1 에서 결정 | M1 |
| A1-2 | 실제 코퍼스(공유 XObject 문서 2~3개, PLAN.md 8절)로 재실행. 이번 픽스처는 합성 문서다 | M0 후속(A7 과 함께) |
| A1-3 | L1(Resources 상속 Form)은 컨테이너 리소스를 인스턴스에 복사하면 해소 가능. 코퍼스에서 빈도 확인 후 결정 | M1 |
| A1-4 | Windows 다른 뷰어(Chrome 기본·Acrobat·pdf.js)에서 `fixtures/m0/m0-shared-xobject-edited.pdf` 표시·검색 확인 | 사용자(Day 1 9.3 과 같은 절차) |

PLAN.md 반영 필요:
- 3.4 "공유 Form XObject … M0 에서 검증 후 확정" → "확정: 편집 사용 위치만 새 인스턴스로 교체(임시 페이지 redaction), 중첩이면 상위 체인 인스턴스화, 1.6 L1–L7 은 편집 제한".
- 1.3 표 "공유 객체·클립·투명도" 행의 Form XObject 문구를 위와 같이 갱신.

## 2. 기존 Redact 주석이 있는 문서

### 2.1 픽스처

`fixtures/m0/m0-preexisting-redact.pdf` (14,428 B, sha256 `5231fc5a…49ba`). 생성: `tools/spike-m0/src/fixture-redact.ts`. 두 쪽 모두 Day 1 샘플 페이지.

| 주석 | 쪽 | 위치(MuPDF 좌표) | 의미 |
|---|---|---|---|
| R1 Redact | 1 | [56, 206, 400, 238] 인접 문단 | 적용 대기 가림 표시, `/OverlayText (REDACTED (R1))`, `/Contents` |
| R2 Redact | 1 | [56, 130, 300, 148] | 교체 대상 문단 첫 줄 일부와 겹침 |
| 메모 Text(+Popup) | 1 | [440, 152, 460, 172] | 교체 대상 영역 안 |
| Link | 1 | [60, 140, 200, 150] | 교체 대상 첫 줄 위, URI |
| R3 Redact | 2 | [50, 302, 300, 322] 꼬리말 | 다른 쪽 가림 표시 |

편집: Day 1 과 같은 교체 대상 영역 `[56, 128, 540, 192]` 의 문단을 한글 문단으로 교체.

### 2.2 구현(`packages/pdf-ops/src/redact-existing.ts`)

| API | 내용 |
|---|---|
| `listRedactAnnots(doc, pageIndices?)` | 문서(또는 지정 쪽)의 Redact 주석 수·쪽 목록·주석별 쪽·`/Annots` 순번·객체 번호·위치(MuPDF 좌표)·QuadPoints 수·OverlayText·Contents |
| `assessRedactionImpact(doc, pageIndex, editRects)` | 편집 전 판정: 그 쪽의 기존 Redact 주석, 편집 영역과 겹치는 것, 함께 지워질 링크, 수준(`none`/`info`/`warn`)과 사용자 메시지 |
| `detachRedactAnnots` / `reattachRedactAnnots` / `withRedactAnnotsDetached` | 임시 분리: `/Annots` 에서 Redact 주석만 빼 두고 원래 순서 자리에 되돌림(주석 객체는 수정하지 않음). 분리가 반영되지 않으면 즉시 되돌리고 예외(2.5 F2) |
| `redactRegions`(기존) | 새 주석만 주석 단위 `applyRedaction` 으로 적용. 기존 주석 수 반환 |

### 2.3 처리 정책 초안

| 상황 | 처리 |
|---|---|
| 편집하는 쪽에 기존 Redact 주석 없음 | `none` |
| 기존 Redact 주석 있음, 편집 영역과 겹치지 않음 | `info`: "적용되지 않은 Redact 표시 N개 있음, 편집은 이 표시를 적용하지 않으며 저장 후에도 표시로 남음" |
| 편집 영역과 겹치는 기존 Redact 주석 | `warn`: "나중에 그 표시를 적용하면 새 텍스트도 지워짐". 편집은 진행(기존 표시를 지우거나 옮기지 않음) |
| 편집 영역과 겹치는 링크 | `warn`: "링크 N개가 함께 제거됨"(2.5 F1) |
| 페이지의 모든 Redact 주석을 적용하는 동작이 필요할 때(페이지 단위 `applyRedactions`, 향후 일괄 처리) | 임시 분리(`withRedactAnnotsDetached`) 후 실행. 기본 편집 경로는 주석 단위 적용이라 분리가 필요 없다 |

- 기존 주석을 사용자 동의 없이 적용·삭제·이동하지 않는다. 기존 주석 적용은 별도 명시 기능(v1 범위 밖)으로 둔다.

### 2.4 결과

실행: `pnpm --filter @pdf-editor/spike-m0 spike:redact` → `out/m0-dod/redact-result.json`(git 제외). 렌더 MuPDF scale 2, 비교 제외 영역 = 교체 대상 영역(+2 px).

편집 전 보고(`assessRedactionImpact`, 1쪽): 기존 2개(R1·R2), 겹침 R2, 링크 제거 예정 1개(`https://example.com/m0-link`), 수준 `warn`, 메시지 3개. 문서 전체 `listRedactAnnots`: 3개, 쪽 [0, 1].

| 측정 | 편집 경로(주석 단위) | 대조: 페이지 단위 `applyRedactions` | 정책: 임시 분리 + 페이지 단위 |
|---|---|---|---|
| 편집 후 Redact 주석(1쪽, 2쪽) | 2, 1 | **0**, 1 | 2, 1 |
| R1·R2·R3 주석 객체(사전 문자열) | 불변 | 불변(1쪽 `/Annots` 에서 빠짐) | 불변 |
| 원본 객체 중 변경 | 1쪽 페이지 사전 1개 | 동일 | 동일 |
| 인접 문단(R1 아래) 텍스트 | 유지 | **삭제** | 유지 |
| 교체 대상 문단 | 삭제, 새 한글 문단 있음 | 삭제 | 삭제 |
| 메모 주석 / 링크 | 유지 / 제거 | 유지 / 제거 | 유지 / 제거 |
| 1쪽 교체 영역 밖 vs 원본 | 0 px | 9,874 px | 0 px |
| 2쪽 vs 원본 | 0 px | 0 px | 0 px |
| 저장 | 전체, 23,342 B, 1.4 ms | 전체, 13,129 B | 전체, 14,060 B |
| 재열기: Redact 주석 쪽·위치·OverlayText·Contents | 3개 모두 동일 | 1쪽 2개 없음 | 3개 모두 동일 |
| 재열기: R1·R2·R3 객체 트리(번호 무관, /P 제외) | 동일 ×3 | R3 만 동일 | 동일 ×3 |
| 재열기: 교체 영역 밖 / 2쪽 | 0 / 0 px | 9,874 / 0 px | 0 / 0 px |
| Poppler: 인접 문단·새 문단 텍스트, 2쪽 | 검출·검출, 0 px | 미검출·해당 없음, 0 px | 검출·해당 없음, 0 px |
| MuPDF 경고·오류 | 0 | 0 | 0 |

- 고정 결과 파일: `fixtures/m0/m0-preexisting-redact-edited.pdf`(편집 경로, 23,342 B, sha256 `1ad05bc8…67b6`). 재생성 시 같은 해시.
- 자동 테스트: `packages/pdf-ops/test/redact-existing.test.ts`(7건), `tools/spike-m0/test/redact-existing.test.ts`(4건).

### 2.5 발견

| # | 내용 | 근거(실측) | 처리 |
|---|---|---|---|
| F1 | MuPDF redaction(주석 단위·페이지 단위 모두)은 영역과 겹치는 **링크 주석을 지운다**. 메모(Text)·Popup 은 남긴다(주석 단위 적용이면 다른 Redact 주석도 남는다) | 링크 1 → 0, `/Annots` 에서 링크 객체만 빠짐 | `assessRedactionImpact` 가 미리 보고(`warn`). 링크를 새 문단 위치로 복원할지는 M3 결정(A2-1) |
| F2 | MuPDF 는 열려 있는 페이지 객체를 캐시하고 `/Annots` 변경을 다시 읽지 않는다. `PDFPage.update()` 로도 재동기화되지 않는다 | 그 쪽 `PDFPage` 를 유지한 채 분리하면 다음 `loadPage` 가 같은 객체를 돌려주고, 페이지 단위 redaction 이 분리한 R1 을 적용해 인접 문단 삭제. 해제 후에는 정상 | `detachRedactAnnots` 가 분리 직후 새로 연 페이지에 분리한 주석이 보이면 되돌리고 예외. 호출자는 그 쪽 `PDFPage` 를 모두 `destroy()` 해야 한다 |
| F3 | **MuPDF 1.28.1 결함**: 압축 필터가 있는 이미지 XObject(JPEG `DCTDecode`, `addImage` Flate)를 `PDFObject.resolve()` 한 문서를 `garbage=compact`(또는 `deduplicate`)로 저장하면 그 이미지가 스트림 없는 사전으로 기록된다. 재열기 시 `format error: object is not a stream`, 이미지 미표시 | 결과 핸들을 `destroy()` 해도 같음. `garbage=yes`·garbage 없음은 정상. 간접 참조에서 `get()` 만 쓰거나 `loadImage(ref)` 는 정상. Form·ICC·콘텐츠 스트림·필터 없는 이미지는 정상. Day 1 단일 페이지 샘플에서도 재현 | 이번 스파이크의 객체 diff 도구가 이 결함을 밟아 2쪽 공유 이미지가 사라짐(12,544 px = 56 pt 이미지 × scale 2)을 발견. 도구는 garbage 없는 저장 사본으로 비교하도록 수정. 제품 코드 점검: `pdf-ops` 의 `resolve()` 는 Contents·Annots 배열과 Resources 사전에만 쓰여 해당 없음. 대조 테스트 `tools/spike-m0/test/mupdf-pitfalls.test.ts`(MuPDF 동작이 바뀌면 실패) |

### 2.6 Action Items(2번 항목)

| # | 내용 | 시점 |
|---|---|---|
| A2-1 | 편집 영역과 겹쳐 제거되는 링크의 처리(새 문단 영역으로 재생성 / 사용자 확인) 결정 | M3 |
| A2-2 | 뷰어 UI: 문서 열기 시 `listRedactAnnots` 결과(쪽·개수) 표시, 편집 전 `assessRedactionImpact` 메시지 표시 | M3(viewer-ui) |
| A2-3 | F3 회피 규칙을 코드 규칙으로 고정: 저장할 작업 문서에서 이미지 XObject 를 `resolve()` 하지 않는다(사전 값은 간접 참조 `get()`). M1 `PageModel`·`SourceMap` 구현 리뷰 항목에 포함. 또는 전체 저장 옵션을 `garbage=yes,compress` 로 바꾸는 안을 3절 측정과 함께 결정 | M1 |
| A2-4 | F3 을 MuPDF 이슈 트래커에 재현 절차와 함께 보고할지 결정(외부 게시이므로 사용자 판단) | 사용자 |
| A2-5 | Windows 다른 뷰어에서 `fixtures/m0/m0-preexisting-redact-edited.pdf` 의 Redact 표시 유지·텍스트 확인(Acrobat 은 Redact 주석을 "적용 대기" 로 표시하는지 포함) | 사용자 |

PLAN.md 반영 필요:
- 3.1 "기존 Redact 주석 … 사전 감지해 구분 처리한다(사용자 경고 또는 임시 분리)" → "감지·보고(`listRedactAnnots`), 편집은 주석 단위 적용으로 기존 주석을 적용하지 않음, 겹침·링크 제거는 경고, 페이지 단위 적용이 필요한 작업만 임시 분리" 로 확정.
- 7절 리스크에 F3(이미지 `resolve()` + compact 저장 결함)과 회피 규칙 추가.
