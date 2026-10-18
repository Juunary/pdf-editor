# M1 pdf-ops: 콘텐츠 스트림 인터프리터 · 원본 연결 정보 · 매칭

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-19 |
| 브랜치 | `m1-pdf-ops`(기준 `97a6fb4`, 계약 수정 1 `956c57b` 머지, worktree `/mnt/nas4/kjune/pdf-editor-m1-pdf-ops`) |
| 범위 | `docs/m1-contract.md` 5.1절 |
| 상태 | `buildSourceMap`·`linkPage` 구현 완료. glyphSeq 계수 정책(계약 3.1)은 결정 대기이므로 두 안을 상수 1개로 전환할 수 있게 구현했다(기본 pdf-ops 안 A). 결정 후 기본값만 바꾼다 |
| 측정 환경 | 서버 `sailab01`, Node 22, npm `mupdf` 1.28.1, `Page.runPageContents(device, Matrix.identity)`(주석 제외). MuPDF 동작 근거는 Device 실측과 MuPDF 1.28.x C 소스(`pdf-op-run.c`·`pdf-interpret.c`·`pdf-font.c`·`pdf-type3.c`·`pdf-cmap.c`·`pdf-layer.c`·`path.c`) 대조 |

## 1. 구현 범위

| 파일 | 내용 |
|---|---|
| `src/content-stream.ts` | 기존 토크나이저 확장: `parseContentOpsLenient`(오류 전 연산 + 오류 위치), `decodeStringToken`(리터럴·16진 디코드 + 바이트별 원본 위치, MuPDF `lex_string` 규칙), 인라인 이미지 EI 판정을 MuPDF `parse_inline_image` 와 맞춤(필터 없는 이미지는 데이터 길이 계산), BI 사전 토큰 보존 |
| `src/content-interp.ts` | 인터프리터. 그래픽·텍스트 상태 머신, /Contents 배열(MuPDF 와 같이 공백 1바이트로 연결), Form 재귀, 리소스 체인(MuPDF `pdf_lookup_resource`), 텍스트 실행 단위·플러시·클립 누적(ET 재전송) 에뮬레이션, 재질(색·셰이딩 패턴·타일링 패턴), 타일링 패턴 직접 실행 판정, 이미지·인라인 이미지·셰이드, 선택적 콘텐츠·marked content, 연산별 SourceOp 기록, 계수 정책 |
| `src/pdf-fonts.ts`, `src/glyph-names.ts` | 코드 분리와 글리프 폭(MuPDF `pdf_decode_cmap`·`pdf_lookup_hmtx`·`pdf_lookup_vmtx` 규칙). Sonnet 서브에이전트 구현, 6절 |
| `src/optional-content.ts` | /OC 숨김 판정(MuPDF `pdf_is_ocg_hidden`, usage View, 기본 구성 /D) |
| `src/link.ts` | `linkPage` 본체(번호 짝짓기·원점 검증·재동기화·`unmatched` 표시) |
| `src/source-map.ts` | 계약 시그니처 그대로 `buildSourceMap`·`linkPage` 연결 |
| `test/helpers/page-model.ts` | 테스트 전용 최소 PageModel 생성기(Device 콜백, core 의존 없음, 두 계수 정책) |
| `test/helpers/device-log.ts` | 테스트 전용 Device 기록 헬퍼 |

내보내기: 패키지 index 는 기존대로 `buildSourceMap`·`linkPage`·옵션 타입만 새로 노출한다(`content-stream.ts` 의 새 함수 포함). 인터프리터·폰트·OC·정책 선택(`buildSourceMapImpl`)은 내보내지 않는다.

### 1.1 SourceOp 기록 규칙

| 필드 | 규칙 |
|---|---|
| `stream`·`range` | 연산 시작(첫 피연산자) 위치의 스트림, 그 스트림 디코드 바이트 기준 [start, end). 스트림 경계를 넘는 연산은 end 를 그 스트림 길이로 자르고 `spans-stream-boundary` |
| `formPath` | `FormStep.doOrdinal` 은 계약대로 "그 스트림 안의 Do 순번"(xobject.ts 는 /Contents 연결 바이트 기준이라 다중 스트림 페이지에서는 값이 다를 수 있다. 단일 스트림 페이지는 같음을 테스트로 확인) |
| `ctm` | 연산 실행 직전 CTM(콘텐츠 → 사용자 공간, Form /Matrix 포함) |
| `clipDepth` | 연산 실행 직전 활성 클립 수. W 계열 칠하기, Form BBox, ET 클립 텍스트가 1씩 늘리고 Q·Form 종료가 되돌린다 |
| `mcids` | 열린 marked content 의 MCID(바깥 → 안). Form 안에서도 바깥 MCID 를 이어 받는다 |
| `optionalContent` | BDC /OC 안 또는 /OC 가 있는 Form 안(켜짐 여부 무관) |
| `text` | `tm` 은 연산 실행 직전 값(`'`·`"` 의 T* 전). 간격 값(`Tc`·`Tw`)은 글리프 배치에 쓴 값(`"` 가 설정한 뒤) |
| `glyphSeq` | 그 연산 글리프 번호의 [최소, 최대+1). 번호가 없으면 생략 |
| `paintSeq` | 칠하기 연산·W(클립)·Form `Do`(BBox 클립)·이미지(마스크 이미지는 2개)·`sh`·인라인 이미지·패턴 색 텍스트 실행 단위(fillShade, 단위의 첫 글리프 연산) |
| `limits` | 아래 표 |

| 제한 사유 | 다는 조건 |
|---|---|
| `tokenizer-error` | 그 콘텐츠(페이지 /Contents 연결 또는 Form 스트림)에서 토큰 오류가 나면 그 콘텐츠의 모든 연산 |
| `spans-stream-boundary` | 연산이 /Contents 스트림 경계를 넘음 |
| `form-inherits-resources` | formPath 의 Form 중 자체 /Resources 없는 것이 있음 |
| `tagged-content` | MCID 가 열려 있음, 또는 formPath 의 Form 에 /StructParents·/StructParent |
| `form-depth-exceeded` | Form 순환, 또는 깊이 상한(xobject.ts 와 같은 조건: Do 경로 길이 ≥ maxFormDepth)으로 실행하지 않은 `Do` |
| `optional-content` | `optionalContent` 가 true(꺼진 /OC 안의 연산 전부 포함, 계약 V5) |
| `type3-font` | Type3 폰트 텍스트 |
| `font-encoding-unresolved` | 폰트가 코드 분리·폭을 MuPDF 와 같게 재현하지 못함(6절), 또는 Tf 전 텍스트 |
| `clip-text` / `invisible-text` | Tr 4–7 / Tr 3 |
| `inline-image` | BI |
| `unmatched` | `linkPage` 가 그 연산 소유 번호 중 짝이 없는 것을 찾음(map 을 고친다) |
| `form-bbox-overflow`·`outside-page-content` | 편집 시점 판정·해석 대상 밖이라 달지 않음 |

## 2. 검증 전제 확인 결과(실측 2026-10-19)

근거 테스트 `test/mupdf-device-premises.test.ts`(18건).

| # | 결과 |
|---|---|
| V1 | 성립. Form `Do` 는 내용 앞에 BBox clipPath 1개(계약 수정 1 반영) |
| V2 | 성립(ET 재전송 제외). Tj·TJ·Td·T*·'·"·Tf 변경·q 는 묶이고 색·선 상태·gs·Q·cm·W·marked content 는 나눈다 |
| V3 | 불일치(계약 수정 1 에 기록, 3.1 결정 대기). Tr 4–7 글리프는 ET 에서 새 텍스트 객체로 재전송 |
| V4 | 성립 |
| V5 | 불일치 → 계약 수정 1 로 정정(꺼진 /OC 안에서도 클립·Tr 3·ET 재전송은 온다) |

## 3. MuPDF 전달 시점 모델(인터프리터가 에뮬레이션하는 동작)

### 3.1 텍스트

- 실행 단위: 같은 tos 모드의 연속 글리프. 플러시 시점은 색공간·색·패턴 설정, `w`·`j`·`J`·`M`·`d`·`ri`, `gs`(Font 만 있는 경우 제외), `Q`, `cm`, `W`·`W*`, `ET`, `BMC`·`BDC`·`EMC`·`MP`·`DP`, 콘텐츠 끝(페이지·Form·패턴 셀, MuPDF `op_END`), 다음 글리프의 Tr 변경. `q`·`BT`·`Tf`·경로 칠하기·`Do`·`BI`·`sh` 는 플러시하지 않는다(Form 안 글리프가 페이지의 진행 중 실행 단위에 합쳐진다).
- 플러시 시 도착: 모드 0·4 fill, 1·5 stroke, 2·6 fill+stroke(같은 객체), 3 ignore, 7 없음. 0–7 밖의 Tr 은 없음. 꺼진 /OC 면 fill·stroke 없음(ignore 는 있음). 채움 재질이 셰이딩 패턴이면 clipText + fillShade, 타일링 패턴이면 clipText + 패턴, 선도 같다(clipStrokeText).
- 클립 누적: 모드 & 4 인 글리프(꺼진 /OC 포함, 0–7 밖 값도 비트 연산 그대로)는 ET 에서 다시 간다. 마지막 실행 단위 모드가 4–7 이면 clipText(클립 +1), 3 이면 ignoreText, 그 밖은 없음. 콘텐츠 끝에서는 보내지 않고, 누적은 BT 로 지워지지 않는다(Form 을 넘어 이어진다).
- Type3: Tr ≥ 4 는 −4, 3 이 아니면 0(MuPDF 9.3.6 처리). 클립 누적 없음. 글리프 프로시저 직접 실행(render_direct)은 에뮬레이션하지 않는다(7절).
- 클립 누적이 남은 상태의 `cm` 은 MuPDF 가 예외로 페이지 해석을 끝낸다. 인터프리터도 오류를 기록하고 멈춘다.

### 3.2 칠하기(paintSeq)

| 연산 | 콜백 |
|---|---|
| f·F·f*·S·s·B·B*·b·b* | 재질별: 색 1, 셰이딩 패턴 clip+fillShade 2, 타일링 패턴 clip 1(+셀). 채움 다음 선. 꺼진 /OC 면 없음. 빈 경로도 콜백 |
| W·W* | 다음 칠하기 연산 뒤 clipPath 1(소유: W 연산). 꺼진 /OC 에서도 있음 |
| Form `Do` | BBox clipPath 1(꺼진 BDC 안에서도), Form /OC 가 꺼졌거나 순환이면 없음 |
| 이미지 `Do` | 1, /SMask·스트림 /Mask 가 있으면 clipImageMask + fillImage 2. /ImageMask 는 채움 재질로 칠한다. 꺼진 /OC 면 없음 |
| BI | 1(/IM 이면 채움 재질) |
| sh | 1 |
| SMask(gs) | beginMask~endMask 안 콜백은 세지 않는다(계약 수정 1). 구간 밖 추가 콜백 없음(실측: 텍스트·이미지·Form·sh·W n·BI) |

타일링 패턴(MuPDF `pdf_show_pattern`): 칠할 경계(MuPDF `fz_bound_path` + 선 확장 `adjust_rect_for_stroke`)를 패턴 공간으로 옮겨 `(fx1−fx0 > 1 또는 fy1−fy0 > 1)` 이고 패턴이 블렌드를 쓰지 않으면 beginTile 경로(core 는 1 을 돌려 셀 미실행 → 계수 없음). 그 밖은 셀 내용을 타일 수만큼 직접 실행한다. 이때 셀 콜백은 소유 연산 없이 번호만 소비한다(SourceOp 없음). 셀 안에서는 색 있는 패턴이면 칠하는 쪽 재질만, 색 없는 패턴이면 둘 다 색으로 되돌린다(MuPDF `pdf_unset_pattern`).

## 4. glyphSeq 계수 정책(계약 3.1 결정 대기)

`src/content-interp.ts` 의 `GLYPH_SEQ_POLICY` 상수로 전환한다. 인터프리터는 글리프마다 도착(fill·stroke·fill+stroke·ignore·clip·clip-stroke)을 기록하고 정책이 번호를 정한다. 번호를 받는 도착 시점의 CTM 으로 원점을 계산한다(MuPDF 는 텍스트 객체를 플러시 시점 CTM 으로 보낸다: ET 재전송 전 Q, Form 경계를 넘는 실행 단위).

| 정책 | 규칙 | core 쪽 판정(테스트 헬퍼 `test/helpers/page-model.ts` 구현) |
|---|---|---|
| `first-arrival`(기본, pdf-ops 안 A) | 글리프의 첫 도착에서 1 | ① 직전 텍스트 콜백과 포인터가 같으면 세지 않음(Tr 2·6, 패턴 색 fill→stroke) ② clipText·clipStrokeText·ignoreText 글리프 중 (폰트 포인터, gid, trm 6값)이 집합 K 에 있으면 ET 재전송으로 보고 세지 않음. K 에는 fillText·strokeText 로 센 글리프만 넣음. 재전송을 찾은 콜백 뒤 K 비움 ③ gid −1 보조 글리프는 세지 않음 |
| `no-clip`(core 안 A) | clip·clip-stroke 도착은 세지 않음. 그 밖은 모두 셈. 이미 번호가 있는 글리프가 다시 세어지면(ET ignore 재전송) 소유 없는 번호 | clipText·clipStrokeText 미계수. 직전 텍스트 콜백과 포인터가 같고 그 콜백을 셌으면 미계수 |

정책별 결과(실측 2026-10-19)

| 항목 | first-arrival | no-clip |
|---|---|---|
| 합성 Tr 0–7 조합 14건: 총수 차이 | 0 | 0 |
| 합성 Tr 0–7 조합 14건: 글자 전부 매칭 | 14/14 | 13/14(`4 Tr (Ab) 0 Tr (Xy) 7 Tr (Cd) 3 Tr (In)`: ET ignore 재전송 중복 2글자가 소유 없는 번호) |
| 무작위 콘텐츠 퍼징 356쪽: 매칭 실패 쪽 | 37 | 4 |
| 실패 원인 | 인터프리터 R2 4쪽 + core 쪽 판정 오판 33쪽(글리프 단위: 가짜 재전송 69, 놓친 재전송 105) | 인터프리터 R2 4쪽 |
| Tr 7·패턴 색 텍스트 | ET 시점·표시 시점 번호로 PageModel 에 들어감 | 번호 없음(PageModel 에 없음) |

퍼징: 고정 시드 400쪽(텍스트 Tr 0–7, 셰이딩·타일링 패턴, 꺼진·켜진 /OC, MCID, Form, 이미지, 인라인 이미지, sh, q/Q·cm·W·gs) 중 44쪽은 MuPDF 가 예외로 페이지 해석을 끝내므로(BT 안 cm 이 클립 텍스트 누적 중 실행, "CTM CHANGE IN CLIP TEXT") 비교에서 뺐다. 인터프리터도 같은 지점에서 중단 오류를 기록한다.

first-arrival 의 core 쪽 판정은 Device 스트림에 ET 경계 정보가 없어 구조적으로 휴리스틱이다. ① 같은 위치에 같은 글리프를 다시 그린 경우(예: 같은 Form 을 같은 CTM 으로 Tr 0 뒤 Tr 7 로 다시 Do)를 재전송으로 오판하고, ② 패턴 색 Tr 4–6 텍스트의 ET 재전송(첫 도착이 clipText)을 놓친다. 퍼징은 이런 조합을 과대표집한다. 결정 근거로 메인 세션에 전달했다(2026-10-19).

## 5. 매칭률(실측 2026-10-19)

기준: 테스트 전용 PageModel(MuPDF Device 콜백, first-arrival 판정). 매칭 = 총수 차이 0, 소유 번호 글자·도형 전부 짝, 원점 오차 0.01pt 이하.

### 5.1 합성 PDF(`test/source-map.test.ts`, 57건 통과)

| 범주 | 내용 | 결과 |
|---|---|---|
| 스트림·바이트 범위 | /Contents 3개, 피연산자·문자열이 스트림 경계에 걸침(MuPDF 공백 연결로 코드 32 글리프 생김), 리터럴 이스케이프·16진 글리프 바이트 범위 | 전부 매칭 |
| Form | 2단 중첩 + /Matrix, 자체 /Resources 없는 Form(L1), 깊이 상한·순환(L5), xobject.ts 사용 위치 색인과 경로·CTM·nameRange 일치 | 전부 매칭 |
| 텍스트 상태 | Tm·Td·TD·T*·TL·Tc·Tw(코드 32)·Tz·Ts·TJ 조정(소수)·'·", 회전 CTM + /Rotate 90 | 원점 오차 < 0.01pt |
| 폰트 | Type0 Identity-H, Identity-V(/W2), 폭 정보 없는 Helvetica(WinAnsi), Type3(/FontMatrix 0.01, 소수 폭), CID 매핑 미상 CMap(UniKS-UCS2-H) | 전부 매칭(마지막은 원점 불일치를 번호 연속으로 인정, `font-encoding-unresolved`) |
| Tr 0–7 | 14개 조합 × 정책 2, Tr 7 의 ET 시점 번호, Form 안 텍스트가 페이지 BT 실행 단위·클립 누적에 합쳐짐 | 4절 표 |
| 선택적 콘텐츠 | 꺼진 BDC 안 Tr 0–7·경로·W n·이미지·sh·Form, /OC 꺼진 Form, BT 안 BDC 경계, OCMD(AnyOn·AllOff)·켜진 OCG, MCID | 전부 매칭 |
| 도형 | W·W*·빈 경로·B 계열, 인라인 이미지(데이터 안 EI, /IM), 이미지 /SMask(2개), 셰이딩 패턴(칠하기·선·Tr 0·2 텍스트), 타일링 패턴(직접 실행·beginTile·선 패턴 셀 안 채움 패턴 재실행), SMask | 전부 매칭(타일링 셀 콜백은 소유 없는 번호라 매칭 대상 밖). 셰이딩 패턴 색 Tr 6 은 전달 순서열이 MuPDF 와 같고 core 쪽 판정만 재전송을 놓친다(R6) |
| 오류 | 토크나이저 오류, Tf 리소스 누락(hail-mary), Tf 전 텍스트 | 오류 1건·앞 연산 4개 `tokenizer-error` / 전부 매칭·`font-encoding-unresolved` / 글리프 없음 |
| linkPage | 모델에 글자 1개를 끼워 번호를 민 경우 재동기화, 원점 2pt 어긋남(허용치 1 → 0/3, 3 → 3/3) | 기대대로 |

### 5.2 fixtures/m0(`test/fixtures-m0.test.ts`)

| 문서 | 쪽 | 결과 |
|---|---|---|
| m0-sample.pdf | 1 | 전부 매칭 |
| m0-shared-xobject.pdf | 2 | 전부 매칭 |
| m0-shared-xobject-edited.pdf | 2 | 전부 매칭 |
| m0-preexisting-redact.pdf | 2 | 전부 매칭 |
| m0-preexisting-redact-edited.pdf | 2 | 전부 매칭(Type0 NotoSansKR 서브셋 포함) |
| m0-spike-saved.pdf | 1 | 전부 매칭 |

6개 문서 10쪽, 매칭 실패 0, 총수 차이 0, 원점 오차 0.01pt 이하. 실패 유형 없음. 실제 코퍼스(`fixtures/corpus`) 측정은 통합 단계(계약 6절 3)에서 한다.

### 5.3 전달 순서열 퍼징(`test/delivery-fuzz.test.ts`)

정책과 무관하게 인터프리터의 Device 전달 순서열(텍스트 도착 종류·글리프 수, 칠하기 순서)을 MuPDF 와 비교한다. 4절과 같은 고정 시드 400쪽: MuPDF 예외 종료 44쪽(인터프리터도 같은 지점 중단), 비교 356쪽 중 일치 352쪽, 불일치 4쪽(시드 44·132·288·390, 전부 타일링 패턴 색 텍스트의 타일 수 판정 R2). 테스트는 불일치 집합이 이 4개와 같음을 고정한다. 실행 약 3.4초.

퍼징으로 찾아 고친 인터프리터 결함: 텍스트 원점을 표시 시점 CTM 으로 계산하던 것(→ 도착 시점), 직각 판정을 경로 공간에서만 하던 것(→ 비직각 CTM 은 변환 선분으로 판정, MuPDF `fz_bound_path`), 패턴 셀 안에서 채움·선 재질을 모두 해제하던 것(→ 색 있는 패턴은 칠하는 쪽만).

### 5.4 성능(실측 2026-10-19, 서버 Node)

합성 1쪽(글리프 3,670·경로 2,000·연산 4,165): `buildSourceMap` 12.7–33.8ms, `linkPage` 5.7–9.5ms(3회, 첫 회가 가장 느림).

## 6. 폰트 폭·코드 분리(pdf-fonts.ts)

Sonnet 서브에이전트가 구현하고 MuPDF Device 콜백과 대조했다(`test/pdf-fonts.test.ts` 151건, 실측 2026-10-19). 리뷰·통합은 Opus.

| 항목 | 결과 |
|---|---|
| 단순 폰트 /Widths | FirstChar 오프셋, 구간 밖 MissingWidth, 짧은 배열 0, 잘못된 First/Last → first=last=0, 실수 폭은 `floor(f+0.5)`(MuPDF `pdf_to_int`) |
| 표준 14(/Widths 없음) | 12개 텍스트 글꼴 × {없음, Standard, WinAnsi, MacRoman} × 코드 0–255 폭·gid 불일치 0. AGL 이름 전부를 Differences 로 넣어도 불일치 0. Symbol·ZapfDingbats 내장 인코딩 불일치 0. 별칭(Arial 등)은 공백 무시, 1.28.1 WASM 실측대로 `ABCDEF+` 접두어는 벗기지 않음 |
| Type3 | 폭 = trunc(float32(float32(a·w)·1000)). /FontMatrix 가 없으면 항등(MuPDF 동작) |
| Type0 | Identity-H/V, /W 두 형식, DW, W2·DW2, 홀수 끝 바이트(코드 0, 1바이트), 겹치는 /W(MuPDF 와 같은 정렬·이진 탐색) |
| CMap | 임베디드 CMap(혼합 코드스페이스, cidrange·cidchar, usecmap, /WMode), MuPDF 1.28.1 이 읽는 사전 정의 CMap 56종의 코드스페이스(Adobe CMap 표본 대조). 읽지 못하는 CMap 이름·필수 키 누락은 MuPDF 와 같이 hail-mary(Times-Roman + StandardEncoding) 로 대체 |
| 실 PDF 대조 | 서버의 PDF 약 1,200개에서 폰트 10,075개를 새 문서에 옮겨 비교: 실제 불일치 0(Type3 /FontMatrix 항등 + 좌표 1e5 이상에서 float32 잡음 6건). 임시 스크립트는 삭제 |
| 재현 못 함(`unresolved` 표시) | 사전 정의 CMap 의 CID 매핑표(폭이 균일하면 정확), 임베디드 폰트 + /Widths 없음, Symbol·ZapfDingbats + /Encoding, AGL 표 밖 글리프 이름, MacExpertEncoding, 시작 CID 가 같은 /W 항목 |

## 7. 남은 제한

| # | 내용 | 영향 | 처리 |
|---|---|---|---|
| R1 | Type3 글리프 직접 실행(MuPDF `render_direct`: 캐시 불가 글리프는 글리프 프로시저를 Device 로 직접 실행하고 텍스트는 ignore)을 에뮬레이션하지 않는다 | 그런 글리프가 있으면 paintSeq 가 늘고 글리프 도착 종류가 바뀐다 | linkPage 재동기화. 코퍼스에서 빈도 확인 |
| R2 | 패턴 색 텍스트의 타일 수 판정에 쓰는 글리프 경계는 근사(em 상자 + 1)다. MuPDF 는 실제 글리프 경계를 쓴다 | 타일링 패턴 색 텍스트에서 직접 실행 여부·타일 수가 다를 수 있다(퍼징 356쪽 중 4쪽) | 재동기화. 셀 칠하기는 소유 연산이 없어 편집 연산 매칭에는 영향이 작다 |
| R3 | 토크나이저 오류 뒤는 해석하지 않는다. MuPDF 는 오류 토큰을 건너뛰고 계속한다(최대 100회) | 오류 뒤 번호가 MuPDF 와 어긋난다 | `tokenizer-error`, 해당 콘텐츠 편집 불가(L6) |
| R4 | 필터 있는 인라인 이미지의 EI 는 앞뒤 공백 조건으로 찾는다(MuPDF 는 디코더가 데이터를 소비한 뒤 찾음) | 압축 데이터 안 우연한 " EI " 에서 잘못 끝날 수 있다 | L6 와 같은 위험. 코퍼스에서 확인 |
| R5 | 깊이 상한(기본 8)을 넘은 Form 은 해석하지 않는다. MuPDF 는 순환이 아니면 실행한다 | 그 뒤 번호 어긋남 | `form-depth-exceeded`, 재동기화 |
| R6 | first-arrival 정책의 core 쪽 판정 한계(4절): 같은 위치 같은 글리프 재그리기를 재전송으로 오판, 패턴 색 Tr 4–6 의 ET 재전송을 놓침 | 그 글자 번호가 어긋난다(퍼징 356쪽 중 33쪽) | 재동기화, 해당 글자 `unmatched`. no-clip 정책이면 생기지 않는다 |
| R7 | CID 매핑을 모르는 미리 정의된 CMap(UCS2·UTF16·UHC 등) 폰트는 폭이 균일하지 않으면 원점이 틀린다 | 원점 검증 불가 | `font-encoding-unresolved`, 번호 연속으로만 매칭 |
| R8 | 도형 매칭 검증: 경로는 CTM, 이미지는 단위 사각형 경계, Form BBox 클립·셰이드는 종류만 본다 | 같은 CTM 의 연속 칠하기 사이 재동기화가 틀릴 여지 | 주인 없는 번호에서는 재동기화하지 않고, 재동기화는 다음 2개 항목 확인 후 채택 |
| R9 | 주석 외관·SMask 그룹·패턴 셀·Type3 글리프 프로시저 스트림은 SourceOp 를 만들지 않는다(L4) | 편집 대상 아님 | — |
| R10 | MuPDF 는 클립 텍스트 누적 중 `cm` 에서 예외로 페이지 해석을 끝낸다(core `runPageContents` 도 예외) | 그 페이지는 PageModel 이 없다 | 인터프리터도 같은 지점에서 멈추고 오류를 기록한다. core 쪽 예외 처리는 통합 시 확인 |

## 8. Action Items

| # | 내용 | 담당 |
|---|---|---|
| P1 | 계약 3.1 결정 후 `GLYPH_SEQ_POLICY` 기본값 확정(안 A 면 변경 없음), 계약 수정 2 머지 | 메인 세션 → pdf-ops |
| P2 | 계약 3절 보완 요청 3건(2026-10-19 메인 세션에 전달): 타일링 패턴 직접 실행 시 셀 콜백, 마스크 이미지 2콜백, ToUnicode 1:N 보조 글리프(gid −1) 미계수 | 메인 세션 |
| P3 | 통합 시 core PageModel 로 fixtures/m0·코퍼스 매칭률 재측정(테스트 헬퍼와 core 판정이 같은지 확인) | 메인 세션(통합) |
| P4 | 코퍼스에서 R1·R2·R4 빈도 확인 후 에뮬레이션 추가 여부 결정 | M1 통합 후 |
| P5 | core 에 R10(페이지 해석 예외) 전달, 정책 결정 시 4절 퍼징 수치 참고 | 메인 세션 |
