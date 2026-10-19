# M1 pdf-ops: 콘텐츠 스트림 인터프리터 · 원본 연결 정보 · 매칭

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-19 |
| 브랜치 | `m1-pdf-ops`(기준 `97a6fb4`, 계약 수정 1–6 머지(`956c57b`·`43e1c22`·`77707d5`·`c84f3fa`), worktree `/mnt/nas4/kjune/pdf-editor-m1-pdf-ops`) |
| 범위 | `docs/m1-contract.md` 5.1절 |
| 상태 | 계약 5.1 범위 구현 완료. glyphSeq 계수는 계약 3.1 확정 규칙(첫 등장 계수, 수정 6 판정, `GLYPH_SEQ_POLICY = 'first-arrival'`). 코퍼스 정책 비교용 측정 도구(`@pdf-editor/pdf-ops/measure`, 5.5절) 제공 |
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
| `src/measure.ts` | 측정 도구(하위 경로 `@pdf-editor/pdf-ops/measure`, index 미노출): 정책 지정 SourceMap, 쪽·문서 측정, Markdown 표 |
| `src/clock.ts` | 경과 시간 측정(빌드 lib 호환) |
| `test/helpers/page-model.ts` | 테스트 전용 최소 PageModel 생성기(Device 콜백, core 의존 없음. 계약 3.1 판정·수정안·no-clip 비교) |
| `test/helpers/device-log.ts` | 테스트 전용 Device 기록 헬퍼, 계수 대상 콜백 전달 순서열(`deliveryTrace`) |
| `test/helpers/first-arrival.ts` | 계약 3.1 core 판정 구현(수정 6, 테스트 전용, PageModel 헬퍼와 전달 순서열이 공유). 수정 2–5 의 1단계는 비교 옵션 |
| `test/corpus-measure.test.ts` | 코퍼스 측정 러너(`LINK_MEASURE_DIR` 지정 시만 실행, 5.5절) |
| `test/helpers/fuzz-content.ts` | 고정 시드 무작위 콘텐츠 생성기(테스트 도구, pdf-ops 비의존. 통합 단계 core 퍼징용) |

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
| V3 | 불일치 → 계약 수정 2 로 확정(첫 등장 계수, 3.1). Tr 4–7 글리프는 ET 에서 새 텍스트 객체로 재전송 |
| V4 | 성립 |
| V5 | 불일치 → 계약 수정 1 로 정정(꺼진 /OC 안에서도 클립·Tr 3·ET 재전송은 온다) |

## 3. MuPDF 전달 시점 모델(인터프리터가 에뮬레이션하는 동작)

### 3.1 텍스트

- 실행 단위: 같은 tos 모드의 연속 글리프. 플러시 시점은 색공간·색·패턴 설정, `w`·`j`·`J`·`M`·`d`·`ri`, `gs`(Font 만 있는 경우 제외), `Q`, `cm`, `W`·`W*`, `ET`, `BMC`·`BDC`·`EMC`·`MP`·`DP`, 콘텐츠 끝(페이지·Form·패턴 셀, MuPDF `op_END`), 다음 글리프의 Tr 변경. `q`·`BT`·`Tf`·경로 칠하기·`Do`·`BI`·`sh` 는 플러시하지 않는다(Form 안 글리프가 페이지의 진행 중 실행 단위에 합쳐진다).
- 플러시 시 도착: 모드 0·4 fill, 1·5 stroke, 2·6 fill+stroke(같은 객체), 3 ignore, 7 없음. 0–7 밖의 Tr 은 없음. 꺼진 /OC 면 fill·stroke 없음(ignore 는 있음). 채움 재질이 셰이딩 패턴이면 clipText + fillShade, 타일링 패턴이면 clipText + 패턴, 선도 같다(clipStrokeText).
- 클립 누적: 모드 & 4 인 글리프(꺼진 /OC 포함, 0–7 밖 값도 비트 연산 그대로)는 ET 에서 다시 간다. 마지막 실행 단위 모드가 4–7 이면 clipText(클립 +1), 3 이면 ignoreText, 그 밖은 없음. 콘텐츠 끝에서는 보내지 않고, 누적은 BT 로 지워지지 않는다(Form 을 넘어 이어진다).
- Type3: Tr ≥ 4 는 −4, 3 이 아니면 0(MuPDF 9.3.6 처리). 클립 누적 없음.
- Type3 직접 실행(MuPDF `render_direct`, `src/type3.ts`, 코퍼스 결함 수정 2026-10-19): MuPDF 는 폰트를 읽을 때 글리프 프로시저마다 장치 플래그를 계산한다(`fz_prepare_t3_glyph`). 시작은 채움·선 색과 선 상태(끝 모양·연결·마이터·폭·대시) "미정" 이고, `d0` 은 COLOR, `d1` 은 MASK + 색 미정 해제, 색 연산·`w`·`j`·`J`·`M`·`d`(gs 의 LW·LC·LJ·ML·D 포함)는 해당 미정을 푼다. 칠하기가 미정 상태를 쓰면(채움 색 미정, 선 색·연결·폭·대시 미정, 대시 있을 때 끝 모양 미정, 마이터 연결일 때 마이터 미정) 캐시 불가다. 캐시 불가 글리프(또는 색 있는 d0 글리프 + 패턴 채움 색)는 표시할 때 실행 단위를 끊고 글리프 프로시저를 새 처리기로 직접 실행한다(CTM = FontMatrix × trm × CTM, 현재 색·선 상태 상속, 글꼴·텍스트 객체·숨김·marked content 는 새로, 숨김 카운터 0 이라 꺼진 /OC 안에서도 칠하기가 온다). 그 뒤 글리프는 Tr 3(ignoreText)으로 보낸다. 직접 실행 칠하기 번호는 그 텍스트 연산이 소유하고 `outside-page-content`(L4)를 단다. 프로시저 안 `d1` 은 장치 MASK 를 켜 이후 색 연산을 무시하게 하지만, MuPDF 가 직접 실행 뒤 장치 플래그를 되돌리므로 글리프 안에서만 유효하다.
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

타일링 패턴(MuPDF `pdf_show_pattern`): 칠할 경계(MuPDF `fz_bound_path` + 선 확장 `adjust_rect_for_stroke`, 비직각 CTM 은 변환 선분으로 직각 판정)를 패턴 공간으로 옮겨 `(fx1−fx0 > 1 또는 fy1−fy0 > 1)` 이고 패턴이 블렌드를 쓰지 않으면 beginTile 경로(core 는 1 을 돌려 셀 미실행 → 계수 없음). 그 밖은 셀 내용을 타일 수만큼 직접 실행한다. 셀 칠하기 번호는 그 패턴 칠하기 연산(경로 칠하기·패턴 색 텍스트 실행 단위의 첫 연산·이미지 마스크)의 `paintSeq` 에 넣고 그 연산에 `outside-page-content` 를 단다(계약 수정 3). 셀 글리프는 소유 연산 없이 번호만 소비한다. 셀 안에서는 색 있는 패턴이면 칠하는 쪽 재질만, 색 없는 패턴이면 둘 다 색으로 되돌린다(MuPDF `pdf_unset_pattern`).

## 4. glyphSeq 계수(계약 3.1 확정: 첫 등장 계수)

### 4.1 구현

인터프리터는 글리프마다 도착(fill·stroke·fill+stroke·ignore·clip·clip-stroke)을 기록하고, 확정 규칙대로 첫 도착에서 번호를 준다(`GLYPH_SEQ_POLICY = 'first-arrival'`). 번호를 받는 도착 시점의 CTM 으로 원점을 계산한다(MuPDF 는 텍스트 객체를 플러시 시점 CTM 으로 보낸다: ET 재전송 전 Q, Form 경계를 넘는 실행 단위). 비교용으로 `no-clip`(채택하지 않은 core 안 A) 정책도 남겨 둔다(`buildSourceMapImpl` 인자, index 미노출).

테스트 헬퍼의 core 쪽 판정(`test/helpers/first-arrival.ts`)은 계약 3.1 의 0–5단계(수정 6)와 같다: gid −1 제외, 직전 텍스트 콜백과 포인터가 같은 텍스트 콜백을 종류 무관하게 건너뛰기, 센 목록(항목 목록, 키 = 폰트 포인터·gid·trm 6값·콜백 ctm 6값)에 fill·stroke 와 clipText·clipStrokeText 신규 글리프를 넣기, 클립·숨김 콜백에서 같은 키 항목 하나 소비, 소비가 있었던 콜백 뒤 비우기, 마스크 구간 제외.

### 4.2 퍼징 측정(`test/policy-fuzz.test.ts`, 실측 2026-10-19)

고정 시드 400쪽(`test/helpers/fuzz-content.ts`) 중 MuPDF 가 예외로 해석을 끝내는 44쪽(R10)을 뺀 356쪽. 실패 = 총수 차이 또는 소유 번호 글자·도형 미매칭. 글리프 단위 비교는 전달 순서열이 같은 쪽에서, 인터프리터가 아는 실제 첫 도착·재전송과 core 쪽 판정을 비교한다.

| 판정 | 실패 쪽 | 원인별 실패 쪽 | 가짜 재전송(글리프) | 놓친 재전송(글리프) |
|---|---|---|---|---|
| 계약 3.1 판정(수정 6) | 23 | R2 4, 가짜 재전송 18, 놓친 재전송만 1 | 73 | 8 |
| 수정 2–5 의 1단계(비교) | 33 | R2 4, 가짜 재전송 18, 놓친 재전송만 11 | 73 | 67 |
| no-clip(비교용) | 4 | R2 4 | — | — |

원인

- R2(4쪽): 인터프리터의 타일링 패턴 색 텍스트 타일 수 판정(글리프 경계 근사). 판정 규칙과 무관하다.
- 가짜 재전송(18쪽, 73글리프): 키(폰트·gid·trm·ctm)가 비트 단위로 같은 다른 글리프가 센 목록에 있었다. 퍼징에서는 같은 Form 을 같은 CTM 으로 여러 번 Do 하는 경우가 대부분이다(같은 위치 같은 글자 덧그림, 계약 3.1 알려진 한계). 소비 뒤 목록을 비우므로 그 BT 의 진짜 재전송을 이어서 놓치기도 한다(수정안의 놓친 4글리프, seed 247).
- 놓친 재전송, 수정 2–5 규칙에서만(10쪽, 59글리프): 같은 텍스트 객체의 두 번째 콜백이 clipStrokeText 인 경우(채움·선 모두 패턴 색, 또는 채움 색 + 선 패턴 색인 Tr 6). 1단계가 fillText·strokeText 만 건너뛰므로 clipStrokeText 가 첫 콜백 글리프를 소비하고 목록을 비워, 이어지는 ET 재전송을 새 글리프로 센다. 4.3 의 수정안(계약 수정 6 으로 채택)이 이를 없앤다.
- ET 재전송 ctm 전제(계약 3.1 "ET 재전송의 ctm = 표시 시점 ctm")의 근거: PDF 32000-1 8.2 그림 9(그래픽 객체: 텍스트 객체 안 허용 연산)는 BT…ET 안에서 `cm`·`q`·`Q`·`Do` 를 허용하지 않는다. MuPDF 1.28 은 클립 텍스트 누적 중 `cm` 이 오면 "CTM CHANGE IN CLIP TEXT" 예외로 페이지 해석을 끝낸다(`pdf-op-run.c` `pdf_run_cm`, 퍼징 400쪽 중 44쪽이 이 경우이고 인터프리터도 같은 지점에서 멈춘다). 따라서 정상 콘텐츠에서는 전제가 성립한다. 예외는 MuPDF 가 중단하지 않는 비표준 콘텐츠뿐이다(아래 항목).
- 놓친 재전송, 수정 6 에도 남는 것(1쪽, 4글리프, seed 130): BT 안 Q(비표준)로 CTM 이 바뀐 뒤 ET 재전송이 와서 ctm 키가 표시 시점과 다르다. MuPDF 는 재전송을 ET 시점 CTM 으로 보낸다(인터프리터 원점도 그 값). BT 안 `Q`(비표준, MuPDF 는 예외 없이 gstate 를 되돌림)가 클립 누적 중 CTM 을 바꾼 경우로, 위 전제의 비표준 예외다. BT 안 `Do`(비표준, `cm` 없이)로 페이지의 클립 누적이 Form 의 ET 에서 Form CTM 으로 재전송되는 경우도 같은 예외다(Form /Matrix 가 항등이 아닐 때만 키가 달라진다).

### 4.3 계약 3.1 판정 불일치 보고와 수정안(2026-10-19 보고, 계약 수정 6 으로 채택)

재현(회귀 테스트): `test/source-map.test.ts` "패턴 색 Tr 6: 같은 객체 clipStrokeText 는 1단계로 건너뛴다". `BT 6 Tr (Ef) Tj ET`(채움·선 셰이딩 패턴)과 `BT 6 Tr (Gh) Tj ET`(채움 색, 선 셰이딩 패턴) → 실제 표시 글리프 4개, 인터프리터 4, 확정 규칙 core 판정 8.

| MuPDF 콜백 | 확정 규칙 | 수정안 |
|---|---|---|
| clipText(Ef) → fillShade → clipStrokeText(같은 객체) → fillShade → ET clipText(재전송) | 2 새로 셈 → 같은 객체 clipStroke 가 소비·비움 → 재전송 2 새로 셈 | 2 새로 셈 → 같은 객체라 건너뜀 → 재전송 소비 |
| fillText(Gh) → clipStrokeText(같은 객체) → fillShade → ET clipText(재전송) | 같음(4 셈) | 2 셈 |

수정안 문구(1단계): "직전 텍스트 콜백과 텍스트 객체 포인터가 같은 텍스트 콜백은 종류와 무관하게 통째로 건너뛴다(같은 실행 단위의 fill→stroke, 패턴 색 clip→clipStroke, fill→clipStroke). ET 재전송은 항상 새 텍스트 객체로 온다." 알려진 한계에 "BT 안 Q 또는 BT 안 Form Do 로 ET 재전송 시점 CTM 이 표시 시점과 달라지면 재전송을 놓친다" 추가.

## 5. 매칭률(실측 2026-10-19)

기준: 테스트 전용 PageModel(MuPDF Device 콜백, first-arrival 판정). 매칭 = 총수 차이 0, 소유 번호 글자·도형 전부 짝, 원점 오차 0.01pt 이하.

### 5.1 합성 PDF(`test/source-map.test.ts`, 57건 통과, 계약 3.1 판정 기준)

| 범주 | 내용 | 결과 |
|---|---|---|
| 스트림·바이트 범위 | /Contents 3개, 피연산자·문자열이 스트림 경계에 걸침(MuPDF 공백 연결로 코드 32 글리프 생김), 리터럴 이스케이프·16진 글리프 바이트 범위 | 전부 매칭 |
| Form | 2단 중첩 + /Matrix, 자체 /Resources 없는 Form(L1), 깊이 상한·순환(L5), xobject.ts 사용 위치 색인과 경로·CTM·nameRange 일치 | 전부 매칭 |
| 텍스트 상태 | Tm·Td·TD·T*·TL·Tc·Tw(코드 32)·Tz·Ts·TJ 조정(소수)·'·", 회전 CTM + /Rotate 90 | 원점 오차 < 0.01pt |
| 폰트 | Type0 Identity-H, Identity-V(/W2), 폭 정보 없는 Helvetica(WinAnsi), Type3(/FontMatrix 0.01, 소수 폭), CID 매핑 미상 CMap(UniKS-UCS2-H) | 전부 매칭(마지막은 원점 불일치를 번호 연속으로 인정, `font-encoding-unresolved`) |
| Tr 0–7 | 14개 조합 × 정책 2, Tr 7 의 ET 시점 번호, Form 안 텍스트가 페이지 BT 실행 단위·클립 누적에 합쳐짐 | 4절 표 |
| 선택적 콘텐츠 | 꺼진 BDC 안 Tr 0–7·경로·W n·이미지·sh·Form, /OC 꺼진 Form, BT 안 BDC 경계, OCMD(AnyOn·AllOff)·켜진 OCG, MCID | 전부 매칭 |
| 도형 | W·W*·빈 경로·B 계열, 인라인 이미지(데이터 안 EI, /IM), 이미지 /SMask(2개), 셰이딩 패턴(칠하기·선·Tr 0·2 텍스트), 타일링 패턴(직접 실행·beginTile·선 패턴 셀 안 채움 패턴 재실행), SMask | 전부 매칭. 직접 실행 셀 칠하기는 패턴 칠하기 연산 소유·`outside-page-content`, 셀 글리프 6개만 소유 없음. 패턴 색 Tr 6 은 4.3 재현 |
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

정책과 무관하게 인터프리터의 Device 전달 순서열(텍스트 도착 종류·글리프 수, 칠하기 순서)을 MuPDF 와 비교한다. 4.2 와 같은 고정 시드 400쪽: MuPDF 예외 종료 44쪽(인터프리터도 같은 지점 중단), 비교 356쪽 중 일치 352쪽, 불일치 4쪽(시드 44·132·288·390, 전부 타일링 패턴 색 텍스트의 타일 수 판정 R2). 테스트는 불일치 집합이 이 4개와 같음을 고정한다. 실행 약 3.4초.

퍼징으로 찾아 고친 인터프리터 결함: 텍스트 원점을 표시 시점 CTM 으로 계산하던 것(→ 도착 시점), 직각 판정을 경로 공간에서만 하던 것(→ 비직각 CTM 은 변환 선분으로 판정, MuPDF `fz_bound_path`), 패턴 셀 안에서 채움·선 재질을 모두 해제하던 것(→ 색 있는 패턴은 칠하는 쪽만).

### 5.4 성능(실측 2026-10-19, 서버 Node)

합성 1쪽(글리프 3,670·경로 2,000·연산 4,165): `buildSourceMap` 12.7–33.8ms, `linkPage` 5.7–9.5ms(3회, 첫 회가 가장 느림).

### 5.5 코퍼스 측정 도구

| 구성 | 내용 |
|---|---|
| `@pdf-editor/pdf-ops/measure` | `buildSourceMapForPolicy(doc, page, policy)`, `measurePage(doc, page, model, policy)`, `measureDocument(file, doc, provider, policies)`, `formatMeasureTable(docs)`. provider 는 `(doc, page, policy) => PageModel`(core `extractPage` 를 정책별로 감싸거나 테스트 헬퍼) |
| 실패 쪽 정의 | 총수 차이(글리프·도형) ≠ 0 이거나 SourceMap 소유 번호의 글자·도형 중 미매칭이 있는 쪽. 소유 없는 번호(패턴 셀 글리프 등)는 따로 집계 |
| 러너 | `LINK_MEASURE_DIR=<폴더> LINK_MEASURE_OUT=<경로> pnpm --filter @pdf-editor/pdf-ops exec vitest run test/corpus-measure.test.ts`(정책 기본 `first-arrival,no-clip`, `LINK_MEASURE_POLICIES` 로 지정). 결과 `<경로>.json`(문서별·정책별 요약, 실패 쪽 번호, 쪽 예외, 열기 실패)과 `<경로>.md`(문서별·정책별 표 + 합계). PageModel 은 테스트 헬퍼(MuPDF Device, 계약 3.1 판정) |
| 시험 실행 | fixtures/m0 6개 문서 10쪽: 두 정책 모두 실패 0(테스트 `fixtures-m0.test.ts` 가 같은 도구로 확인) |

### 5.6 실제 코퍼스(`fixtures/corpus` 19건 1,647쪽, 실측 2026-10-19)

| 측정 | 기준 PageModel | 결과 |
|---|---|---|
| 메인 세션 통합 측정(수정 전) | core `extractPage`, first-arrival | 글자 4,126,758개 미매칭 0, 글리프 총수 차이 0. 실패 11쪽 전부 도형 총수 차이: arxiv-2609.10511 p2·3·6(차이 합 460), zen-ko-moon-21973474 p0·6·8·13·16·18·19·20(차이 합 750) |
| 원인 | — | 두 문서 모두 캐시 불가 Type3 글리프(arxiv: Ghostscript `d0` + 색 미지정 채움, zen-ko: `d1` + 선 상태 미정 B)의 직접 실행(R1) 미에뮬레이션. Device 전달 순서열 비교로 확인 |
| 수정 후, 두 문서 | core `extractPage`(m1 의 `packages/core/test/corpus-link.test.ts`) | 37쪽 실패 0, 도형 18,978개 미매칭 0, 총수 차이 0 |
| 수정 후, 전체 | 테스트 헬퍼(`test/corpus-measure.test.ts`), first-arrival·no-clip | 두 정책 모두 1,647쪽 실패 0, 글자 4,126,758·도형 182,110 미매칭 0, 총수 차이 0, 쪽 예외 0 |

러너 메모리: 동기 루프에서는 mupdf 래퍼의 FinalizationRegistry 정리가 돌지 않아, 테스트 헬퍼가 만든 Device 가 콜백 클로저(쪽 데이터)를 장치 표에 남겨 JS 힙이 3GB 를 넘었다. 헬퍼에서 Device·Text 를 명시적으로 해제한다. 문서를 `destroy()` 한 뒤 이벤트 루프를 양보하면 남은 PDFObject 래퍼 정리가 해제된 문서에 접근해 WASM 메모리 오류가 나므로, 러너는 문서를 명시적으로 해제하지 않는다.

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
| R1 | Type3 캐시 가능 판정은 글리프 프로시저의 경로 칠하기만 본다. 프로시저 안 Form `Do`·텍스트·중첩 Type3 의 플래그 영향은 계산하지 않는다(2026-10-19 render_direct 에뮬레이션 추가 전에는 미구현이었고, 코퍼스 2개 문서 11쪽 도형 총수 차이의 원인이었다) | 그런 글리프에서 직접 실행 여부가 다를 수 있다 | linkPage 재동기화 |
| R2 | 패턴 색 텍스트의 타일 수 판정에 쓰는 글리프 경계는 근사(em 상자 + 1)다. MuPDF 는 실제 글리프 경계를 쓴다 | 타일링 패턴 색 텍스트에서 직접 실행 여부·타일 수가 다를 수 있다(퍼징 356쪽 중 4쪽) | 재동기화. 셀 칠하기는 소유 연산이 없어 편집 연산 매칭에는 영향이 작다 |
| R3 | 토크나이저 오류 뒤는 해석하지 않는다. MuPDF 는 오류 토큰을 건너뛰고 계속한다(최대 100회) | 오류 뒤 번호가 MuPDF 와 어긋난다 | `tokenizer-error`, 해당 콘텐츠 편집 불가(L6) |
| R4 | 필터 있는 인라인 이미지의 EI 는 앞뒤 공백 조건으로 찾는다(MuPDF 는 디코더가 데이터를 소비한 뒤 찾음) | 압축 데이터 안 우연한 " EI " 에서 잘못 끝날 수 있다 | L6 와 같은 위험. 코퍼스에서 확인 |
| R5 | 깊이 상한(기본 8)을 넘은 Form 은 해석하지 않는다. MuPDF 는 순환이 아니면 실행한다 | 그 뒤 번호 어긋남 | `form-depth-exceeded`, 재동기화 |
| R6 | 계약 3.1 core 판정 한계(4.2): 같은 위치 같은 글자 덧그림을 재전송으로 오판(구조적), BT 안 Q·Form 으로 재전송 CTM 변경(비표준) | 그 글자 번호가 어긋난다(퍼징 356쪽 중 19쪽, R2 제외) | 재동기화, 해당 글자 `unmatched` |
| R7 | CID 매핑을 모르는 미리 정의된 CMap(UCS2·UTF16·UHC 등) 폰트는 폭이 균일하지 않으면 원점이 틀린다 | 원점 검증 불가 | `font-encoding-unresolved`, 번호 연속으로만 매칭 |
| R8 | 도형 매칭 검증: 경로는 CTM, 이미지는 단위 사각형 경계, Form BBox 클립·셰이드는 종류만 본다 | 같은 CTM 의 연속 칠하기 사이 재동기화가 틀릴 여지 | 주인 없는 번호에서는 재동기화하지 않고, 재동기화는 다음 2개 항목 확인 후 채택 |
| R9 | 주석 외관·SMask 그룹·패턴 셀·Type3 글리프 프로시저 스트림은 SourceOp 를 만들지 않는다(L4) | 편집 대상 아님 | — |
| R10 | MuPDF 는 클립 텍스트 누적 중 `cm` 에서 예외로 페이지 해석을 끝낸다(core `runPageContents` 도 예외) | 그 페이지는 PageModel 이 없다 | 인터프리터도 같은 지점에서 멈추고 오류를 기록한다. core 쪽 예외 처리는 통합 시 확인 |

## 8. 검증(실측 2026-10-19)

| 명령 | 결과 |
|---|---|
| `pnpm exec turbo run build typecheck test --force --continue` | 18개 중 17개 통과. 실패 1개 = `@pdf-editor/core#test` 의 계약 시점 단언(P6). pdf-ops 테스트 11개 파일 269건 통과 |
| `pnpm lint` | 통과 |
| 추적 파일 Prettier | 통과 |

## 9. Action Items

| # | 내용 | 담당 |
|---|---|---|
| P1 | 계약 3.1 확정(첫 등장 계수)·수정 2–4 머지, 기본 정책 first-arrival 유지 | 완료(2026-10-19) |
| P2 | 계약 3절 보완 3건(타일링 직접 실행 셀, 마스크 이미지 2콜백, gid −1 보조 글리프) → 계약 수정 3 반영, 셀 칠하기 소유·`outside-page-content` 구현 | 완료(2026-10-19) |
| P7 | 4.3 수정안·알려진 한계 → 계약 수정 6 채택, 헬퍼 반영 | 완료(2026-10-19) |
| P8 | 통합 후 실제 코퍼스(1,647쪽)에서 first-arrival·no-clip 측정(5.5절 도구, core ModelProvider) 후 정책 최종 확인 | 메인 세션 |
| P3 | 통합 시 core PageModel 로 fixtures/m0·코퍼스 매칭률 재측정(테스트 헬퍼와 core 판정이 같은지 확인) | 메인 세션(통합) |
| P4 | 코퍼스에서 R1·R2·R4 빈도 확인 후 에뮬레이션 추가 여부 결정 | M1 통합 후 |
| P5 | core 에 R10(페이지 해석 예외) 전달, 정책 결정 시 4절 퍼징 수치 참고 | 메인 세션 |
| P6 | `packages/core/test/session.test.ts:74` 의 계약 시점 단언 `getSourceMap` → "M1 미구현" 예외는 pdf-ops 구현으로 실패한다(허용 파일 밖이라 수정하지 않음). 통합 시 그 줄을 지우거나 실제 결과 검증으로 바꾼다 | 메인 세션(통합) |
