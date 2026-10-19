# M3 pdf-ops(S1): 편집 판정 · 제거 · 편집 블록 삽입 · 폰트 배정 · 쓰기

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-19 |
| 브랜치 | `m3-pdf-ops`(기준 `m3` `a7464f1`, worktree `/mnt/nas4/kjune/pdf-editor-m3-pdf-ops`) |
| 범위 | `docs/m3-contract.md` 6.2 작업 S1: 4절 SourceMap 선택 필드, 5.1 판정, D2 제거 확장, D3 삽입, D4 FontManager, 5.5 쓰기, 5.6 메타 |
| 상태 | 범위 구현 완료. V2–V5 세 엔진 확인 완료(합성). 코퍼스 편집 가능 비율 측정 완료. 계약과 다르게 구현한 항목 2건(8절, 메인 세션 확인 필요) |
| 측정 환경 | 서버 `sailab01`, Node 22.18.0, npm `mupdf` 1.28.1, `pdfjs-dist` 6.4.299(legacy 빌드, `@napi-rs/canvas` 1.0.11), Poppler 22.02.0(`pdftoppm -cropbox`·`pdftotext`). 렌더 비교는 scale 2, 주석 제외, 채널 차 8 초과 픽셀 수(계약 8.3) |

## 1. 구현 범위

| 계약 | 파일 | 내용 |
|---|---|---|
| 4절 `source-map.ts` | `src/content-interp.ts` | `TextShowInfo.tlm`(연산 직전, `'`·`"` 는 T* 전), `SourceOp.state`(채움 색 연산 id: cs+sc/scn 또는 g/rg/k, gs 연산 id 누적, 직사각형 클립 교집합: `re`·4점 축 정렬 경로·Form BBox, 그 밖 클립·클립 텍스트는 null, 클립 없으면 쪽 경계), `SourceOp.markedContent`(BMC·BDC 연산 id·태그·MCID·ActualText·BT 안 여부, Form 안은 바깥 것을 이어 받음) |
| D2 건너뜀 코드 | `src/text-remove.ts`, `src/show-ops.ts` | `RemoveTextResult.skipped` 를 `{ opId, code: RemoveSkipCode, detail }` 로 변경. 명세 폭 분석·연산 다시 쓰기는 `show-ops.ts`(M1 제거와 M3 편집 공용) |
| 5.1·5.3 | `src/edit-plan.ts` | 문단 분석(`analyzeParagraph`): 흐름·방향, 편집 블록 대상, 연산 제한, 출처 섞임, ActualText, 제거 분석, 삽입점(D3 규칙 1–3), 삽입점 상태(특이 CTM·클립·패턴·SMask), 경고. 시작 상태(원 문단·편집 블록) |
| D2·D3·5.2 | `src/edit-apply.ts` | 초안 시작 적용: 편집 블록 Form 생성, 스트림별 교체 목록 일괄 적용, Form 사용 경로 복제, ActualText 빼기, 공유 /Contents 사본, Info 사전 생성, 모양 원천 해석 보관 |
| D4 | `src/font-assign.ts`, `src/edit-style.ts` | 역매핑·렌더 탐침·폭 판정, 글자 단위 폴백, 폴백 수명, 저장 서브셋. 모양 원천(sourceChar) 해석 |
| 5.5·5.7 | `src/edit-block.ts` | `writeEditBlock` 본체, `listEditBlocks` 본체 |
| 5.6 | `src/edit-meta.ts` | `recordEditMetadata` 본체, `pdfaDeclared`(index 내보내기 추가) |
| 연결부 | `src/paragraph-edit.ts` | 계약 커밋의 내보낸 시그니처 그대로 본문만 채움 |
| 공통 | `src/edit-common.ts` | 행렬·사각형, 리소스 체인, 스트림 캐시, 숫자 표기, 교체 텍스트 앞뒤 공백 |

## 2. 동작 규칙(계약 대비 세부)

### 2.1 판정(planParagraphEdit · planPageEditability)

- 대상: `LayoutParagraph` 하나. `planPageEditability` 는 표·도형 문단도 넣고 `not-flow-paragraph` 로 표시한다(마우스 오버 사유 표시용).
- 편집 블록 글자를 하나라도 포함하면 대상은 그 블록의 모든 글자(`rewrite-block`). 블록이 아닌 글자는 그대로 둔다.
- 연산 제한 중 편집 불가로 보는 것: `unmatched`·`tokenizer-error`·`spans-stream-boundary`·`form-inherits-resources`·`outside-page-content`·`form-depth-exceeded`·`type3-font`·`font-encoding-unresolved`·`clip-text`·`invisible-text`·`inline-image`·`form-bbox-overflow`. `optional-content` 는 경고, `tagged-content` 는 D1 처리.
- `remove-skipped`: 제거 분석이 건너뛰는 연산(코드는 `ParagraphLimit.code`). Form 안 연산은 복제 경로로 처리하므로 건너뛰지 않는다.
- ActualText: 지울 글리프가 ActualText MC 안이면 그 MC 의 모든 글리프를 함께 지운다. MuPDF 구조화 텍스트가 ActualText 로 글자를 바꿔 MC 의 일부 글리프가 어느 문단에도 들어가지 않기 때문이다(실측). 다른 문단에 속한 글리프가 있으면 `actualtext-partial`.
- 삽입점 클립: 직사각형 클립은 `areaLimit` 에 넣는다. 직사각형이 아닌 클립은 덮음 판정 없이 `insertion-clipped`(보수적, 7절). 직사각형 클립이라도 원 문단 글자 원점이 그 밖에 있으면 `insertion-clipped`(8절 2).
- 경고: `optional-content`, `tagged-structure-kept`·`tagged-structure-unlinked`(MCID 유지 여부·Form 복제본 /StructParents 제거), `actualtext-cleared`, `reading-order-approximate`, `link-overlap`(`PDFPage.getLinks`), `redact-overlap`(`listRedactAnnots`). `font-fallback`·`glyph-missing`·`synthetic-style` 는 `FontManager.assign` 이 낸다. `area-overlaps-content`·`overflow-clipped` 는 리플로우·core 몫.
- `save`: `decideSaveMethod(['content-stream'], canBeSavedIncrementally())` → 항상 전체 저장. 폴백 사용 여부는 판정 시점에 알 수 없어 `font-embed` 는 넣지 않는다(core 가 로그에서 더함, 계약 D9).

### 2.2 제거(D2)

- 연산 일부만 지우기: 지울 글리프는 같은 변위의 TJ 숫자, 남길 글리프는 원 코드 바이트의 16진 문자열. `'`·`"` 는 `T*`·`aw Tw ac Tc T*` 를 앞에 남긴다. 번호 없는 글리프(seq null)는 연산에 남길 글리프가 있으면 남기고 없으면 지운다.
- Form 안 텍스트: 사용 경로 전체(상위 체인 포함)를 새 스트림으로 복제한다. 복제본 사전은 원 사전 키를 복사하고 Length·Filter·DecodeParms·StructParents·StructParent 를 뺀다. 복제본 Resources 는 직접 사본이고 안쪽 단계 이름(`PEF<n>`)·편집 블록 이름(`PEB<n>`)을 더한다. Do 이름 피연산자 바이트만 바꾼다. 원 Form 객체는 바꾸지 않는다.
- ActualText 빼기: 인라인 사전은 BDC 연산 바이트에서 키·값을 지우고, /Properties 이름은 그 홀더(쪽 또는 Form 복제본) Resources 에 ActualText 를 뺀 사본(`PEP<n>`)을 두고 이름을 바꾼다.
- 교체 목록: 스트림 키(쪽 /Contents 칸 또는 Form 객체)별로 원본 바이트 기준 목록 하나를 한 번에 적용한다. 같은 위치의 삽입은 교체보다 먼저 들어간다. 교체 텍스트가 앞뒤 일반 문자와 붙으면 공백을 붙인다.

### 2.3 삽입(D3)

- 편집 블록 Form: `/Matrix` = 삽입점 CTM 역행렬, `/BBox` = `areaLimit` 을 사용자 공간으로 옮긴 사각형, `/Resources` 는 쓰기마다 새로 만든다(쓰는 폰트·색공간·ExtGState 만), `/PdfEditorEdit`(편집 id), `/PdfEditorFormat`(JSON, 비 ASCII 는 `\uXXXX`). JSON 필드: `format`, `runs`(텍스트·크기·굵게·기울임·색·원 폰트 이름·합성 여부), `glyphOffsets`(쓴 글리프마다 텍스트 위치, 재열기 뒤 sourceChar·캐럿 복원), `missing`, `insertion`, `areaLimit`.
- before-bt: BT 바로 앞에 `q /PEB0 Do Q`. 상태 연산 = BT 연산(CTM·클립·gs).
- split-bt: 지점 앞에 `ET q /PEB0 Do Q BT <줄 설정 재실행> [n] TJ`. 기준 연산이 일부만 지우는 연산이고 앞에 남길 글리프가 있으면 다시 쓴 TJ 를 둘로 나누고 사이에 넣는다. 줄 행렬은 계약 표기(`<Tlm> Tm`)와 다르게 마지막 Tm(없으면 BT)부터의 줄 설정 연산을 원 피연산자 그대로 다시 실행해 되돌린다(8절 1). n = −1000·d/(Tfs·Th), d 는 마지막 줄 설정 연산 뒤 표시 연산의 명세 폭 변위 합, n 은 왕복 정확 표기.
- 규칙 3: 지점에 BT 안에서 열린 BMC·BDC 가 열려 있으면 가장 바깥 것 앞으로 옮기고 규칙 1·2 를 다시 적용한다. 옮긴 지점과 기준 글리프 사이에 남길 보이는 글리프가 있으면 `reading-order-approximate`.
- BT 나누기 제한(`bt-split-unsupported`): 그 BT 의 Tr 4–7, BT 안 q/Q/cm(지점과 무관하게 있으면 제한, 보수적), 변위 계산 불가(대체 폰트·폭 불확실·Type3·CID 미매핑), Tfs·Th 0, T* 의 TL 을 알 수 없고 그 뒤 TL 이 바뀜.
- 삽입점 상태: 특이 CTM → `singular-ctm`. 모양 구간마다 원 글자 채움이 패턴이면, 또는 효력 있는 SMask 가 삽입점과 다르면 `graphics-state-mismatch`. 그 밖 ExtGState 차이는 쓰기에서 gs 로 재현한다.

### 2.4 폰트 배정(D4)

- 원본 폰트 조건: (iv) Type1·MMType1·TrueType·Type0, MuPDF 로드 성공, 가로쓰기, 폭 정확(`unresolved` 없음), Type0 은 Identity-H 또는 ToUnicode 있음. (i) ToUnicode(bfchar·bfrange 배열 형식 포함) 역매핑, 없으면 단순 폰트 Encoding(기본 인코딩 + Differences, 글리프 이름 → 유니코드: 표 이름·`uniXXXX`·`uXXXX`). 후보가 여럿이면 이 쪽에서 쓰인 코드 우선. 코드 바이트가 폰트 코드 분할과 맞는지 확인한다. (ii) 임베디드 폰트는 렌더 탐침: 임시 문서에 폰트 사전을 옮기고(`graftObject`, 폰트당 한 번) 판정할 코드를 칸마다 30pt 로 그린 뒤 Device 로 글리프 id(0 이면 불가)를, 렌더로 잉크를 본다. 공백류는 탐침하지 않는다. 비임베디드 폰트는 (ii) 생략. (iii) 명세 폭 > 0(결합 문자 제외).
- 클러스터: `Intl.Segmenter` grapheme. 원본 → 폴백(모든 코드포인트가 폴백 cmap 에 있음) → 없음(`face: null`, `glyph-missing`). 강제 줄바꿈 "\n" 은 앞 구간의 폰트(없으면 원본 폰트 face)를 따르고 `encode('\n')` 은 빈 배열이다. 공백은 원본에 없으면 폴백으로 쓴다(pdfTeX 류 폰트는 공백 글리프가 없다). 공백만 폴백이면 `font-fallback` 경고를 내지 않는다.
- FontSegment.size = 모양 원천 글자의 페이지 공간 크기(`CharInfo.size`, 반올림 전).
- 폴백 수명: 배정·쓰기 때마다 보관한 객체 번호의 사전에 `/PdfEditorFallback true` 가 있는지 확인하고 없으면 지금 작업 안에서 다시 넣는다. 넣는 방법은 `doc.addFont` 가 아니라 임시 문서에 `addFont` 한 사전을 `graftObject` 로 옮기는 것이다(6절 1). 폴백 ToUnicode 의 공백 글리프 항목 U+00A0 은 U+0020 으로 고친다(6절 2).
- `finalizeForSave`(저장 작업 안에서만): FontFile2 를 `subsetFontBytes`(이 세션에서 쓴 gid)로 바꾸고 ToUnicode·/W 도 그 gid 만 남기며 표시를 `/PdfEditorFallback /Subset` 으로 바꾼다. 작업을 버리면 모두 되돌아간다. 재열기 뒤에는 `/Subset` 표시 폰트를 폴백으로 다시 쓰지 않는다(그 블록을 재편집하면 그 서브셋 폰트가 "원본 폰트"로 판정되어 외곽선 없는 글자는 새 폴백으로 간다).
- 합성 굵게·기울임: 폴백으로 쓰는 구간의 `RunStyle.bold`·`italic` 이면 `FontSegment.syntheticBold`·`syntheticItalic`, 경고 `synthetic-style`.

### 2.5 쓰기(5.5)

- 스트림: `q` → `0 Tc 0 Tw 100 Tz 0 TL 0 Ts` → `BT` → 모양이 바뀔 때 채움 색 연산(원래 색공간, cs 리소스는 블록 `CS<n>` 으로 복사, 원 글자가 기본 색이면 `0 g`, sc/scn 만 있으면 `/DeviceGray cs` 를 앞에 둠)·`Tr`(0, 합성 굵게 2, 원 글자 Tr 1·2)·gs(삽입점과 원 글자의 ExtGState 가 다를 때 원 글자 효력값 + 삽입점에만 있는 키의 기본값으로 만든 사전) → 폰트·크기가 바뀌면 `Tf` → 줄 시작·기울임 전환·기준선 변화 때 `Tm`(사용자 공간 절대 위치, 화면 가로 방향 = `userToPage` 역행렬로 계산) → 글자는 `TJ`(펜 위치와 배치 위치 차이를 1/1000 텍스트 공간 숫자로) → `ET` → `Q`.
- 합성 굵게: `2 Tr`, 선 두께 크기 × 0.03, `[] 0 d 0 J 0 j`, 선 색은 채움 연산을 CS/SC/SCN/G/RG/K 로 바꾼 것, 선 알파는 gs `CA` = 원 글자 `ca`. 합성 기울임: Tm 의 y 축 = `userToPage` 역행렬 × (0.2, −1).
- 문자열: 원본 폰트는 `EncodedGlyph.code` 바이트, 폴백은 2바이트 gid. 줄 끝 공백 글리프는 배치 결과에 있으면 그대로 쓴다.

### 2.6 저장 메타(5.6)

- `/PdfEditorEdits` = `pages=<1부터, 합집합 정렬>; structure=not-updated|n/a`(한 번 not-updated 면 유지), `/ModDate` = `D:YYYYMMDDHHmmSSZ`(UTC). `/Producer`·XMP 는 바꾸지 않는다.
- Info 사전이 없으면 `prepareParagraphEdit`(첫 편집 작업 안)이 만든다. `recordEditMetadata` 도 없으면 만들지만 저장 작업 안에서 만들면 버린 뒤 trailer 에 끊긴 참조가 남으므로(계약 11절) core 는 편집 작업에서 만든 것을 전제로 한다.
- `pdfaDeclared(doc)`: `/Metadata` XMP 의 `pdfaid:part`.

## 3. 검증 전제 V2–V5(실측 2026-10-19)

| # | 시험 | MuPDF | pdf.js | Poppler |
|---|---|---|---|---|
| V2 | before-bt(BT 별 3문단, 가운데 교체): 영역 밖 렌더 차이, 재추출 순서(앞 문단 끝 < 새 텍스트 < 다음 문단 처음) | 0 px · 순서 맞음 | 0 px · 순서 맞음 | 0 px · 순서 맞음 |
| V2 | 같은 MuPDF 블록 안 두 문단(13pt 간격) 중 뒤 문단을 길게 교체 | 0 px · 순서 맞음 | 0 px · 순서 맞음 | 0 px · 순서 맞음 |
| V2 | Form 복제(공유 Form·중첩 Form): 편집 쪽 영역 밖, 같은 Form 을 쓰는 다른 쪽 전체 | 0 px · 0 px · 순서 맞음 | 0 px · 0 px · 순서 맞음 | 0 px · 0 px · 순서 맞음 |
| V2 | 공유 /Contents, y 반전 CTM, /Rotate 90·270 | 0 px | 0 px | 0 px |
| V3 | 같은 BT 안 앞·뒤 줄 유지(소수 계수 Tm `0.98 0 0 1.02 50.25 260.125`, Td·TD·T* 섞임): 남은 글자 원점 차 ≤ 1e-3 pt(MuPDF 구조화 텍스트), 영역 밖 | 0 px | 0 px | 0 px |
| V3 | 연산 안 나누기(Tj·Tj 가운데·TJ 조정(Tc·Tw·Tz)·`'`·`"`) | 0 px · 원점 동일 | 0 px | 0 px |
| V3 | BT 안 BMC(규칙 3, BMC 앞으로 옮겨 나눔) | 0 px | 0 px | 0 px |
| V4 | Type0 Noto 의 FontFile2 를 "가나다 abc" 서브셋으로 바꾼 문서(ToUnicode·/W 는 전체): 판정(가나다·abc 원본, 라·마·x·y·z 폴백)과 같은 폰트로 강제로 그린 글자의 잉크 유무 | 일치 13/13 | 일치 13/13 | 일치 13/13 |
| V4 | 폴백 저장(저장 작업 안 `finalizeForSave` → 저장 → 작업 버림): 저장 파일 한글 추출, 작업 문서 FontFile2 전체 유지·undo 가능 | 추출 · 검색 quad 중심이 배치 글자 상자 안 | 추출 | 추출 |
| V5 | BT 바깥 `/P <</MCID 0>> BDC`: 블록 호출이 MC 안(`mcidKept: true`) | – | `includeMarkedContent` MCID 0 텍스트 = 새 텍스트, MCID 1 불변 | – |
| V5 | ActualText(인라인 사전·/Properties 이름) 전부 지움 → 저장 뒤 복사 텍스트에 옛 ActualText 없음, 새 텍스트 있음 | 없음 | 없음 | 없음 |

- 편집 전 문서에서 옛 ActualText 를 내보내는 엔진: 인라인 사전은 Poppler·MuPDF, /Properties 이름은 MuPDF 만(Poppler 22.02 는 이름으로 준 ActualText 를 쓰지 않음, 실측).
- 테스트: `test/paragraph-edit.test.ts`(V2·V3·V5), `test/font-manager.test.ts`(V4), `test/edit-block.test.ts`(쓰기·메타), `test/paragraph-plan.test.ts`(판정).

## 4. 판정 시간(서버 Node, 실측 2026-10-19)

| 대상 | planPageEditability(쪽) | planParagraphEdit(문단) |
|---|---|---|
| 합성 15문단 쪽(16문단으로 복원됨) | 2.66 ms | 평균 0.19 ms, 최대 0.30 ms |
| 코퍼스 48쪽·1,244문단(첫 호출 뒤 두 번째 호출) | 중앙값 2.4 ms, p95 12.9 ms, 최대 20.2 ms | 평균 0.73 ms, p95 5.3 ms, 최대 19.3 ms |

- 계약 예산(쪽 100 ms, 문단 10 ms): 쪽은 모두 통과. 문단은 1/1,244 가 19.3 ms(nasa-se-handbook 4쪽). 같은 문단이 직전 측정에서는 8 ms 미만이어서 일회성 지연(GC 등)으로 본다. 판정마다 분석 환경(폰트 리소스·SMask 캐시)을 새로 만든다.
- 개선 전 측정(같은 날): 문단 최대 17.6 ms. 원인은 쪽 끝까지 누적되는 gs 목록을 모양 구간마다 MuPDF 사전 순회로 다시 합친 것(프로파일 72%). gs 연산별 SMask 캐시로 바꿨다.
- 판정 전 쪽 상태(추출 + SourceMap + 레이아웃, 테스트 도구) 중앙값 42 ms, 최대 835 ms(kogl-mods-cpi 4쪽). core 캐시 대상이다.

## 5. 코퍼스 편집 가능 비율(계약 8.2, 실측 2026-10-19)

- 대상: `fixtures/corpus` 24문서 × 1·4쪽 = 48쪽, 레이아웃 문단 1,244(흐름 문단 645, 표·도형 599).
- 흐름 문단 편집 가능 **559/645 = 86.7%**.

| 첫 사유 | 흐름 문단 수 |
|---|---|
| `type3-font`(Type3 폰트, 계약 1.4 범위 밖) | 64 |
| `insertion-clipped`(삽입점 직사각형 클립이 원 문단 글자를 덮지 않음, 8절 2) | 12 |
| `vertical-or-rotated` | 9 |
| `mixed-content-sources` | 1 |

- 사유 전체(문단당 중복 포함): type3-font 151, remove-skipped(code type3) 151, outside-page-content 34(Type3 글리프 직접 실행), vertical-or-rotated 17, insertion-clipped 12, mixed-content-sources 1, not-flow-paragraph 599. `bt-split-unsupported` 0(같은 날 첫 측정의 5건(arxiv-2609.10511 4쪽)은 줄 설정 재실행 방식으로 바꾼 뒤 0건).

| 문서 | 흐름 | 편집 가능 | 사유(흐름 문단) | 표본 |
|---|---|---|---|---|
| arxiv-2609.09268 | 39 | 38 | vertical-or-rotated 1 | 6 |
| arxiv-2609.10511 | 46 | 24 | type3-font 18, vertical-or-rotated 4 | 6 |
| fed-combined-finstmt-2025 | 17 | 17 | – | 5 |
| fed-h41-current | 19 | 12 | insertion-clipped 7 | 5 |
| jnl-jdis-2026-2-2-7 | 53 | 52 | insertion-clipped 1 | 6 |
| jnl-phwr-2025-18-36-1 | 28 | 28 | – | 6 |
| kogl-mods-cpi-202609 | 14 | 10 | insertion-clipped 4 | 0 |
| kogl-nabo-finstmt2025 | 6 | 6 | – | 0 |
| kogl-nabo-rnd107 | 17 | 17 | – | 4 |
| nasa-eo-2019-maraprl | 39 | 38 | vertical-or-rotated 1 | 6 |
| nasa-eo-2023-sepoct | 32 | 31 | vertical-or-rotated 1 | 6 |
| nasa-eo-2024-janfeb | 22 | 21 | vertical-or-rotated 1 | 6 |
| nasa-se-handbook-sp2016-6105 | 39 | 39 | – | 4 |
| nist-ai-100-1 | 11 | 11 | – | 4 |
| nist-cswp29 | 23 | 23 | – | 6 |
| nist-sp800-171r3 | 17 | 17 | – | 6 |
| nist-sp800-53r5 | 16 | 15 | vertical-or-rotated 1 | 6 |
| ustreas-mts-202509 | 35 | 35 | – | 6 |
| zen-beamer-10545284 | 21 | 20 | mixed-content-sources 1 | 6 |
| zen-beamer-7535020 | 6 | 6 | – | 3 |
| zen-ko-kimtw-23386644 | 15 | 15 | – | 6 |
| zen-ko-moon-21973474 | 52 | 6 | type3-font 46 | 0 |
| zen-ko-report-21333257 | 44 | 44 | – | 4 |
| zen-ko-sim-21496576 | 34 | 34 | – | 6 |

### 5.1 표본 편집 (i) 같은 텍스트로 교체

- 표본: 쪽마다 읽기 순서 앞에서부터 편집 가능하고 20자 이상인 흐름 문단 최대 3개 = 113개. 배치는 테스트 전용 단순 배치(`test/helpers/simple-reflow.ts`: 왼쪽 정렬·공백 뒤 줄 나눔·셰이핑 없음)다. 편집 (ii)·(iii) 와 리플로우 결과 측정은 S2 통합 뒤 한다.
- 삽입 방식: 쪽 before-bt 55, 쪽 split-bt 49, Form 복제 before-bt 4, Form 복제 split-bt 5. 오류 0.
- 영역 밖 렌더 차이(원 문단 bbox ∪ 배치 상자, 여백 2pt): **113/113 이 세 엔진 모두 0 px**.
- 상자 안 텍스트(계약 8.3 정의, 공백 제거 비교): 세 엔진 모두 같음 102/113. 다름 11건 중 10건은 단순 배치가 영역을 넘쳐(표본 27건이 넘침) 넘친 줄이 이웃 문단 자리에 겹친 경우로 상자 안 추출에 이웃 글자가 섞인다. 1건(zen-beamer-10545284 4쪽 #12)은 Poppler 단어 상자 판정(글자 크기 4pt)에서 첫 단어가 빠진 측정 도구 문제다.
- 폰트: 같은 텍스트 교체에서 폴백 사용 1건(nasa-se-handbook 4쪽 #2 의 "."), 쓸 수 없는 글자 1건(arxiv-2609.09268 4쪽 #3 의 U+FFFD, 원본 추출이 이미 U+FFFD).
- 경고: tagged-structure-kept 20, tagged-structure-unlinked 26, link-overlap 17, reading-order-approximate 7, actualtext-cleared 6.
- 표본 편집 시간(판정 + 준비 + 배정 + 단순 배치 + 쓰기, 문서마다 새로 연 문서): 중앙값 4.9 ms, 최대 368 ms(구간 분해는 측정하지 않음).

## 6. 실측으로 확인한 엔진 동작(구현 반영)

1. MuPDF `PDFDocument.addFont` 는 문서별 폰트 캐시(다이제스트 → 객체)를 쓴다. 저널 작업을 버리거나 undo 해 폰트 객체가 사라진 뒤 같은 바이트로 다시 `addFont` 하면 사라진 번호를 돌려주고 `put` 이 `not a dict (null)` 로 실패한다. → 임시 문서에 `addFont` 한 사전을 `graftObject` 로 옮겨 넣는다.
2. MuPDF `addFont` 의 ToUnicode 는 U+0020 과 U+00A0 이 같은 글리프면 U+00A0 으로 적는다(Noto Sans KR gid 1 → `<0001> <00a0>`). 폴백으로 쓴 공백이 NBSP 로 추출되므로 그 항목을 고친다.
3. mupdf.js Device `showGlyph` 의 `trm` 원점은 CTM 적용 전(사용자 공간, y 위)이다. 렌더 탐침의 칸 찾기에 CTM 을 적용해야 한다(여러 줄 격자에서 칸이 뒤바뀌던 버그를 코퍼스에서 발견해 수정).
4. MuPDF 구조화 텍스트는 ActualText 로 글자를 바꾼다. 그 MC 의 글리프 일부만 PageModel 글자·문단에 들어간다(2.1).
5. BT 나누기 뒤 줄 행렬 복원(8절 1): arxiv-2609.09268 1쪽 원본에 블록 없이 `ET BT 1 0 0 1 54 692.105 Tm` 만 넣어도 pdf.js 169 px(최대 채널 차 64, 유효숫자 17자리 표기도 같음), 합친 `ET BT 53.99999999999997 692.105 Td` 는 Poppler 88 px, 원 Td 3개 재실행은 세 엔진 0 px. 재렌더·재저장만으로는 0 px.
6. `pdftoppm` 기본값은 MediaBox 렌더다. CropBox 가 있는 쪽은 MuPDF 쪽 좌표와 어긋나므로 비교에 `-cropbox` 를 쓴다. `pdftotext -bbox` 도 `-cropbox`.
7. pdfjs-dist 6.4.299 의 `PDFDocumentProxy` 에는 `destroy` 가 없어 loadingTask 를 `destroy` 한다(테스트 도구).

## 7. 남은 제한

| 항목 | 내용 |
|---|---|
| 직사각형이 아닌 클립 | 덮음 판정 없이 `insertion-clipped`(계약은 "다 덮지 않으면"). 코퍼스 0건 |
| BT 안 q/Q·cm | 나누는 지점과 무관하게 있으면 `bt-split-unsupported`. 코퍼스 0건 |
| 원 글자 Tr 1·2 | 선 색은 채움 색, 선 두께는 크기 × 0.03(원 선 상태를 SourceOpState 로 받지 않음) |
| 원 글자 Tc·Tw·Tz | 블록은 계약대로 0·0·100 을 쓴다. 자간·장평이 있는 원 문단을 같은 텍스트로 바꾸면 폭이 달라진다 |
| BT 나누기 뒤 같은 줄 남은 글자 | 지운 글리프 변위를 TJ 숫자 하나로 되돌린다. 원래 글리프별 누적과 부동소수 순서가 달라 이론상 안티에일리어싱 차이가 날 수 있다(코퍼스 113표본 0 px) |
| 텍스트 녹아웃 | BT 를 나누면 녹아웃 단위가 바뀐다(겹친 반투명 글자에서만, 기록만, 계약 D3) |
| 렌더 탐침 비용 | 폰트마다 임시 문서에 폰트를 한 번 옮기고 새 글자 묶음마다 렌더 1회. 첫 판정에 수 ms~수십 ms |
| 모양 원천 해석 보관 | `writeEditBlock`·`FontManager.assign` 은 같은 프로세스에서 먼저 `prepareParagraphEdit` 가 보관한 해석(편집 id 별, sourceChar 는 판정 시점 인덱스)을 쓴다. 없으면 `writeEditBlock` 은 예외 |
| `/PdfEditorFormat` | 다른 도구가 블록 스트림을 고쳐 글자 수·텍스트가 다르면 추출 텍스트 + 블록 상자로 시작(계약 5.3). 형식은 그때 left·줄 간격 1.2 |
| 쪽 판정의 Type3 | 코퍼스 흐름 문단 미편집의 74%(64/86)가 Type3(계약 범위 밖) |

## 8. 계약 불일치·메인 세션 확인 요청

1. **D3 규칙 2 `<Tlm>` 표기**: 계약 `ET q /X Do Q BT <Tlm> Tm [n] TJ`(원 Tm 바이트 또는 유효숫자 9자리)는 6절 5 의 실측으로 pdf.js(계산값 Tm)·Poppler(합친 Td)에서 영역 밖 차이를 만든다. 구현은 마지막 Tm(없으면 BT)부터의 줄 설정 연산을 원 피연산자 그대로 같은 순서로 다시 실행한다(Tm·Td 원 바이트, TD → `tx ty Td`, T*·`'`·`"` 줄 이동 → `0 -TL Td` 또는 `T*`). 결과 Tlm 은 계약과 같고 표기만 다르다. 제안: 계약 문장을 이 방식으로 고침. 2026-10-19 메인 세션에 메시지를 보냈으나 전달 실패(상대 세션 훅 시간 초과).
2. **`insertion-clipped` 확장**: 계약은 직사각형 클립을 `areaLimit` 에 넣으라고만 한다. 원 문단 일부를 다른 클립 아래 그린 경우(fed-h41 4쪽 각주: 번호 "1." 만 좁은 셀 클립 안) 블록 BBox 가 18pt 폭이 되어 새 텍스트가 잘렸다(pdf.js·Poppler 는 잘린 글자도 추출해 텍스트 판정이 엇갈림). 원 문단 글자 원점이 삽입점 직사각형 클립 밖에 있으면 `insertion-clipped` 로 막는다. 코퍼스 12문단.
3. `SourceOpState.fillColorOps` 주석은 "기본값이면 null" 이나 타입은 `number[]` 다. 구현은 빈 배열.
4. `RemoveTextResult.skipped[].reason` 을 `code`·`detail` 로 바꿨다(pdf-ops 내보낸 타입, paragraph-edit.ts 밖). 저장소 안 다른 사용처 없음(packages·apps·tools grep).

## 9. 다른 작업과의 연결 주의

- S3(core): 호출 순서는 `planParagraphEdit → prepareParagraphEdit → (assign → layoutParagraph → writeEditBlock)*`. `assign` 은 문서의 마지막 `prepareParagraphEdit` 가 보관한 모양 해석을 쓴다. `replayEdits` 도 편집마다 plan → prepare → write 순으로 부른다. 폴백 폰트를 넣는 `assign`·`writeEditBlock` 은 저널 작업 안에서 불러야 한다(작업 밖이면 MuPDF 예외). `finalizeForSave` 는 D9 저장 작업 안에서만.
- S3: `planPageEditability` 결과 `revision`·`ms` 는 호출자가 채운다. 판정은 쪽 SourceMap·레이아웃 캐시를 그대로 쓰고 문서를 바꾸지 않는다(저널 켠 문서에서 작업 밖 호출 확인).
- S2(reflow): 원본 face 의 `encode('\n')` 은 `[]`, 공백류는 `encode(' ')` 가 원 폰트 공백 코드. 폴백 face 키는 `fallback`, `pdfWidth(gid)` 는 임베딩한 /W(명세 폭). 쓰기는 `WritableGlyph.faceKey`·`code`·`gid`·`x`·`y`·`size`·`pdfWidth`·`runIndex`·합성 플래그만 쓴다(`x`·`y` 는 페이지 공간 기준선 원점).
- 테스트 도구: `vitest.config.ts` 별칭으로 `packages/core/src/extract.ts`·`packages/layout-recon/src` 원본을 테스트에서만 불러 실제 PageModel·PageLayout 을 만든다(패키지 의존성 변경 없음, typecheck 는 동적 import 문자열로 우회).

## 10. 테스트·실행

| 파일 | 내용 |
|---|---|
| `test/source-map-m3.test.ts` | 선택 필드(tlm·fillColorOps·extGStateOps·clipRect·Form BBox·markedContent) |
| `test/paragraph-plan.test.ts` | 편집 제한 사유 전부(not-flow 제외 합성)·경고·시작 상태·판정 시간·저널 켠 문서 |
| `test/paragraph-edit.test.ts` | V2·V3·V5, Form 복제, 공유 스트림, y 반전·회전, Tr 3, 클립, 저널 undo/redo·취소·폴백 재삽입, 재편집(같은 세션·재열기·다른 도구 수정) |
| `test/edit-block.test.ts` | 쓰기 세부(텍스트 상태·색공간·gs·글리프 위치·줄 끝 공백·합성 스타일), 메타·PDF/A |
| `test/font-manager.test.ts` | 역매핑(Type1·TrueType·Type0·쓰인 코드 우선), V4, 폭 0, 폴백·glyph-missing, 저장 서브셋·검색 |
| `test/edit-corpus.test.ts` | 계약 8.2 코퍼스 측정. 환경 변수가 있을 때만 |

```bash
EDIT_CORPUS_DIR=/mnt/nas4/kjune/pdf-editor/fixtures/corpus EDIT_CORPUS_ENGINES=mupdf,pdfjs,poppler EDIT_CORPUS_OUT=/tmp/edit-corpus.json pnpm --filter @pdf-editor/pdf-ops exec vitest run test/edit-corpus.test.ts
```

- 결과 JSON 은 git 밖(위 예 `/tmp`). 2026-10-19 측정 실행 시간 약 100초(세 엔진).
