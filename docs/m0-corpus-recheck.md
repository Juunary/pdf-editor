# M0 실제 코퍼스 재검증 · pdf.js 독립 확인 · Chrome 128–150 DNR 실측

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-19 |
| 범위 | `docs/m0-day1-log.md` 8절 A5(Chrome 128–150 DNR)·A7(실제 코퍼스), 9.3 V3(pdf.js) 대체, `docs/m0-dod-xobject-redact-save.md` A1-2(공유 XObject 실제 코퍼스). M0 마지막 산출물 "v1 범위·일정 재산정" 의 입력 데이터 |
| 수행 위치 | Mustree 서버 `sailab01` `/mnt/nas4/kjune/pdf-editor` (AMD Ryzen 9 5950X 32스레드, Node v22.18.0, mupdf 1.28.1, Poppler 22.02.0, pdfjs-dist 6.4.299, Playwright 1.64.1) |
| 측정 표기 | 이 문서의 수치는 모두 **실측 2026-10-19**, 서버 기준. Windows Chrome 수치 아님 |
| 기준 커밋 | 작업 시작 `0ee4561`, 작업 중 메인 세션 커밋 `d6974a8`(PLAN.md v2.5) 위에서 진행 |
| PLAN.md·Day 1 로그 | 수정하지 않음. 반영 필요 사항은 끝의 "PLAN.md 반영 필요" |
| 결과 원본 | `out/m0-corpus/`(git 제외): `corpus-result.json`, `pdfjs-result.json`, `edited/<id>.pdf`, `pdfjs/*.png`, `dnr/<버전>.json`, `save-bench/*.json`, 대조 실행 `out/m0-corpus-nosubset/` |

## 0. 판정 요약

| # | 항목 | 판정 | 근거 수치 |
|---|---|---|---|
| 1 | 실제 코퍼스 구축(A7) | **완료(일부 유형 대체)** | 19건·1,647쪽, 8개 유형 각 2~3건(benchmark 492쪽·297쪽). 전부 공공영역 또는 CC BY 4.0, 문서별 URL·라이선스 근거·SHA-256 기록. 빈 디렉터리 재수신 19/19 해시 일치. 학술지 게재 한글 CC BY 논문·공공누리 제1유형·한국어 수백 쪽·3단 뉴스레터는 근거를 찾지 못해 미포함(1.3) |
| 2 | 코퍼스 재실행(문단 자동 선택 → 교체 → 전체 저장 → 재열기) | **문단 50/53 성공**(실패 3: 실제 결함 1, Poppler 추출 경계 2) | 문단 선택 19/19 문서. 대상 문단 제거·재열기 텍스트·검색 53/53, 글리프 표시 53/53, 편집 영역 밖(MuPDF) 52/53, Poppler 텍스트·검색 53/53. 전체 저장 19/19, 저장 피크 힙 판정 미탐 0/19. 공유 Form 사용 위치 1곳 복제 정책 9/9(새 줄 배치 7/9) |
| 3 | pdf.js 독립 확인(V3 대체) | **22쌍 중 20쌍 통과** | fixtures/m0 3/3, 코퍼스 17/19. 불일치 2건은 편집하지 않은 쪽 렌더 변화이며 원인은 `subsetFonts()`(서브셋 생략 대조 22/22 통과). npm `pdfjs-dist` 6.4.299 결과이며 Firefox 결과 아님 |
| 4 | Chrome 128–150 DNR 실측(A5) | **완료** | Chrome for Testing 128·140·149: DNR 리다이렉트 동작(http GET·file:// 파일 URL 접근 켬). 150.0.7871.124 는 이미 `chrome.mimeHandler` 경로(150.0.7871.0 부터, 150.0.7828.0 은 없음) → DNR 이 실제로 쓰이는 범위는 128–149 |

새로 확인한 결함·제약(7절 상세)

| # | 내용 | 영향 |
|---|---|---|
| C1 | MuPDF 1.28.1 `subsetFonts()` 는 문서 전체 폰트를 다시 서브셋하며 원본 단순 폰트 `/Widths` 를 정수로 반올림(833.3→833)·미사용 글리프 0 으로 다시 쓴다 | pdfTeX 문서 2건에서 **편집하지 않은 쪽**의 Poppler·pdf.js 렌더가 바뀜(글자 최대 0.13pt 이동). MuPDF 렌더는 동일 |
| C2 | 페이지 redaction 은 쪽 콘텐츠 전체를 다시 직렬화한다(연산자 906→2,069, 바이트 +37%). `ActualText` Span 이 있는 쪽에서 편집하지 않은 문단 첫 줄이 최대 3.1pt 이동(MuPDF 경고 `ActualText with no position`) | 주변 보존 실패 1건(zen-ko-report 23쪽). 편집 후 원본 연산자 바이트 위치(SourceMap) 무효 |
| C3 | 실제 문서의 Form `/BBox` 는 정규화되지 않은 경우가 있다(`[0 792 612 0]`, 시험한 9개 중 4개). `pdf-ops` `outsideFormBBox` 는 정규화를 가정해 4/4 오판 | 공유 Form 편집 L3 판정 오류 |
| C4 | 실제 문서의 저장 힙 증가분은 파일 크기의 0~19.1배(합성 문서 1.5~3.2배). 현재 배율 모델(파일 × 4.48)은 작은 파일에서는 기본 힙 22 MiB 덕에 맞지만 객체 중심 대형 문서에서 과소 추정 가능 | `decideSaveMethod` 경고 경계는 실제 대형 문서로 미검증 |
| C5 | MuPDF stext 는 Word·LibreOffice·InDesign·한컴 출력에서 줄마다 블록을 나눈다(한 줄 블록 비율 최대 1.0) | 문단 12/53 은 줄 병합 보조 경로로만 선택 가능. M2 레이아웃 복원 입력 |
| C6 | 공유 Form 의 BBox 가 CropBox 보다 클 수 있다 | BBox 기준 배치 시 새 줄이 쪽 밖으로 나감(2/9) |

## 1. 실제 코퍼스 구축(A7)

### 1.1 선정 기준

| 항목 | 내용 |
|---|---|
| 라이선스 | 공공영역(미국 연방 저작물, 17 U.S.C. 105), CC0, CC BY, CC BY-SA, 공공누리 제1유형만. 근거 문구(게시 페이지 또는 PDF 본문)를 확인하지 못한 문서는 제외. NC·ND·KOGL 2~4유형 제외 |
| 저장소 정책 | PDF 는 커밋하지 않음(`.gitignore` `fixtures/corpus/*.pdf`). `fixtures/corpus/manifest.json` 에 id·유형·제목·URL·게시 페이지·라이선스·근거 문구·SHA-256·크기·쪽수·생성기·태그 여부·수집일·비고, 못 찾은 유형(`notFound`)·제외 후보(`rejected`) 기록 |
| 내려받기 | `node scripts/corpus/fetch-corpus.mjs`(없는 문서만, sha256·크기 검증, 불일치 시 파일 미보존·실패), `--check`(검증만), `--only id,…` |
| 수집 | 후보 조사 서브에이전트(Sonnet)가 후보 35건을 받아 pdfinfo·pdffonts·라이선스 근거를 기록, 메인 작업에서 MuPDF 구조 점검(공유 Form·태그·문단 선택 가능 여부) 후 19건 선정 |
| 재현 확인 | 빈 디렉터리에서 19건을 원 URL 로 다시 받아 19/19 SHA-256·크기 일치(2026-10-19) |

### 1.2 문서 목록

| id | 유형 | 쪽 | MiB | 라이선스 | 태그 | 생성기 |
|---|---|---|---|---|---|---|
| zen-ko-kimtw-23386644 | korean-paper | 18 | 0.5 | CC BY 4.0(Zenodo) | 예 | Microsoft Word 365 |
| zen-ko-sim-21496576 | korean-paper | 49 | 3.8 | CC BY 4.0(Zenodo) | 아니오 | pdfTeX-1.40.27 |
| zen-ko-moon-21973474 | korean-paper | 22 | 1.4 | CC BY 4.0(Zenodo) | 아니오 | Hancom PDF 1.3.0.538 |
| nist-ai-100-1 | english-report | 48 | 1.9 | 공공영역(미국 연방) | 아니오 | pdfTeX-1.40.24 |
| nist-cswp29 | english-report | 32 | 1.4 | 공공영역(미국 연방) | 예 | Adobe PDF Library 23.8 |
| nasa-eo-2019-maraprl | multicolumn-newsletter | 40 | 6.0 | 공공영역(NASA, 신뢰도 중간) | 예 | Adobe PDF Library 15.0 |
| nasa-eo-2024-janfeb | multicolumn-newsletter | 34 | 6.5 | 공공영역(NASA, 신뢰도 중간) | 예 | Adobe PDF Library 17.0 |
| ustreas-mts-202509 | financial-tables | 40 | 3.8 | 공공영역(미국 연방) | 아니오 | OpenPDF 1.3.43 |
| fed-h41-current | financial-tables | 11 | 0.2 | 공공영역(미국 연방) | 아니오 | Aspose.Words 21.3 |
| fed-combined-finstmt-2025 | financial-tables | 63 | 4.1 | 공공영역(미국 연방) | 예 | Workiva(Wdesk) |
| arxiv-2609.09268 | vector-charts | 16 | 0.5 | CC BY 4.0(arXiv) | 아니오 | arXiv GenPDF/pikepdf(pdfTeX) |
| arxiv-2609.10511 | vector-charts | 15 | 1.1 | CC BY 4.0(arXiv) | 아니오 | arXiv GenPDF/pikepdf(pdfTeX) |
| nist-sp800-171r3 | tagged-pdf | 120 | 1.5 | 공공영역(미국 연방) | 예 | Adobe PDF Library 24.2 |
| zen-ko-report-21333257 | tagged-pdf | 152 | 2.5 | CC BY 4.0(Zenodo) | 예 | InDesign + Adobe PDF Library 16.0 |
| zen-beamer-10545284 | shared-form-xobject | 54 | 2.5 | CC BY 4.0(Zenodo) | 아니오 | pdfTeX-1.40.24(beamer) |
| zen-beamer-7535020 | shared-form-xobject | 81 | 11.3 | CC BY 4.0(Zenodo) | 아니오 | xdvipdfmx(beamer) |
| nasa-eo-2023-sepoct | shared-form-xobject | 63 | 5.0 | 공공영역(NASA, 신뢰도 중간) | 예 | Adobe PDF Library 17.0 |
| nist-sp800-53r5 | benchmark | 492 | 5.8 | 공공영역(미국 연방) | 예 | Adobe PDF Library 20.13 |
| nasa-se-handbook-sp2016-6105 | benchmark | 297 | 3.6 | 공공영역(NASA, 신뢰도 중간) | 예 | Adobe PDF Library 15.0 |

- 유형은 주 유형 1개만 적었다. 태그 PDF 는 11건(StructTreeRoot 기준), 텍스트가 있는 공유 Form 이 있는 문서는 6건(nasa-eo-2023·2024, zen-ko-report, beamer 2건, NASA SE 핸드북)이다.
- 라이선스 신뢰도 주의: Zenodo 라이선스는 업로더 지정값이다(한글 3건은 저자 본인 업로드, zen-ko-report 는 작성 기관 직원 업로드이며 KOICA 지원 사업 조건 미확인). NASA 문서는 NASA 미디어 지침의 "generally not subject to copyright" 근거이며 개별 사진의 제3자 크레딧 가능성이 있다. zen-ko-moon 은 학술 발표 자료(학술지 논문 아님)이다.

### 1.3 못 찾은 유형과 사유

| 유형 | 찾은 범위 | 결과 |
|---|---|---|
| 학술지 게재 한글 논문(CC BY) | arXiv 한국어 논문 17건 라이선스, DOAJ 한국어 CC BY 학술지, Zenodo | arXiv 는 BY-NC-ND·BY-NC-SA·비독점 배포 라이선스뿐(0건). 출판사 조판본을 저자가 올린 Zenodo 문서는 학술지 권리 미확인으로 제외 → Zenodo 저자 원고 3건으로 대체 |
| 공공누리 제1유형 한국 정부 문서 | 개인정보보호위원회 「합성데이터 생성·활용 안내서」 등 | 제1유형을 게시 페이지·PDF 로 확인한 문서 0건. 위 안내서는 PDF 2쪽 "본 안내서 내용의 무단전재를 금하며" 로 제외 |
| 한국어 수백 쪽 benchmark | 공공누리·Zenodo | 미확보. 보건복지백서는 KOGL 제4유형(변경 금지)으로 미사용 |
| GAO·CBO 영문 보고서 | gao.gov, cbo.gov, govinfo | 자동 내려받기 403, govinfo 최근 GAO 미제공 → NIST 2건 |
| 정부 문서 벡터 차트 | EIA STEO, Fed MPR, Fed Z.1 | EIA 는 차트가 래스터. Fed MPR·Z.1 은 본문에 제3자 저작권 고지(S&P Dow Jones Indices 재배포 금지 등) → arXiv CC BY 2건 |
| 3단 뉴스레터 | NIH Catalyst, NIH Record, USGS, CDC | NIH Catalyst 는 공공영역 문구 없음(라이선스 불명확), 나머지 403 → NASA The Earth Observer(2단) 2건 |

제외 후보 15건과 사유는 `manifest.json` `rejected` 에 있다(제3자 저작권 고지 3, 라이선스·권리 근거 부족 7, 유형·쪽수 부적합 3, 예비 2).

## 2. 코퍼스 재실행

### 2.1 방법

실행: `node scripts/corpus/fetch-corpus.mjs` → `pnpm --filter @pdf-editor/spike-m0 spike:corpus`(대조: `-- --no-subset --out out/m0-corpus-nosubset`). 문서마다 분석·편집을 별도 Node 프로세스로 실행(편집 프로세스 WASM 힙 = 그 문서 작업의 최대치).

| 단계 | 내용(코드) |
|---|---|
| 문단 자동 선택 | `tools/spike-m0/src/corpus-select.ts`. Day 1 하드코딩 좌표를 MuPDF stext 블록 판정으로 대체. 조건: 가로쓰기, 3줄 이상·글자 80자 이상, 글자 크기가 문서 본문 크기(훑은 쪽 최빈값) ±15%, 같은 크기 90% 이상, 문자 비율 60% 이상, 왼쪽 정렬, 기준선 간격 0.95–2.4em·편차 25% 이내, 머리·꼬리 5% 띠 밖, **다른 블록 글자의 추정 잉크 범위(기준선 위 0.8em·아래 0.22em)와 redaction 영역이 겹치지 않음**. 블록 후보가 없는 쪽은 연속한 한 줄 블록을 같은 조건으로 이어 붙인 후보(8줄 상한) 사용. 문서 15%·50%·85% 지점에서 쪽당 1개, 최대 3개, 회전 쪽 제외 |
| redaction 영역 근거 | MuPDF redaction 은 글리프 실제 외곽과 조금이라도 겹치면 그 글자를 지운다(실측: 글자 중심이 영역 밖이어도 제거, stext quad 의 위·아래 여백만 겹치면 유지) |
| 구조 분석 | `corpus-analyze.ts`: 쪽 콘텐츠 토크나이저 실패·Contents 경계 분할(L6), Form 사용 위치·공유·텍스트·L1/L2/L5/L7, 폰트 유형·ToUnicode·매핑 위험, 태그·MCID, 주석 |
| 편집 | `corpus-edit.ts`: 문단마다 `redactRegions`(텍스트 제거, 선화·이미지 보존) → `embedFont`(Noto Sans KR glyf 서브셋, 문서당 1회) → 원 문단 줄 수 안에 들어가는 가장 긴 한글 문장(첫 기준선·줄 간격·글자 크기 원본과 동일) → `addPageFontResource`·`appendPageContent`. 문서당 `subsetFonts()` + `decideSaveMethod(…, {inputBytes})` + 전체 저장 1회 |
| 판정(MuPDF) | 대상 줄 잔존 0(같은 쪽 같은 문장 중복을 고려해 등장 횟수 기준), 인접 줄 손실 0, 편집 영역 밖 렌더 차이(96단계 초과 픽셀 0), 글리프 누락 0, 참조 렌더(폰트 파일에서 직접 그린 글리프)와 96단계 초과 차이 0, 재열기 후 텍스트·검색어(`교체 문단 k`, `폴백 폰트로`) 적중·저장 전과 렌더 동일·편집 영역 밖 동일, 편집하지 않은 첫·마지막 쪽 렌더 동일 |
| 판정(Poppler) | `pdftotext` 교체 문장·검색어, `pdffonts` NotoSansKR emb/sub/uni, `pdftotext -bbox` 편집 영역 밖 단어 손실 0·이동 0.5pt 이하. 렌더 차이는 관찰로 기록 |
| 96단계 기준 | 같은 글리프도 원점이 1/4 px 양자화 경계를 걸치면 가장자리가 약 64단계 바뀌고(실측 최대 66), 투명도 그룹 합성은 1단계 차이를 낸다(zen-ko-kimtw 15,040 px 전부 1단계). 글리프 누락·대체(Day 1 CFF 실패)는 255단계라 구분된다. 엄격(0 px) 값은 결과에 함께 남긴다 |

### 2.2 결과: 유형별

| 유형 | 문서 | 문단 | 성공 | 편집 제한(limit) 문단 | 전체 저장 | 저장 힙 판정 미탐 없음 |
|---|---|---|---|---|---|---|
| korean-paper | 3 | 9 | 9 | 3 | 3 | 3/3 |
| english-report | 2 | 6 | 6 | 3 | 2 | 2/2 |
| multicolumn-newsletter | 2 | 6 | 6 | 6 | 2 | 2/2 |
| financial-tables | 3 | 5 | 5 | 4 | 3 | 3/3 |
| vector-charts | 2 | 6 | 6 | 0 | 2 | 2/2 |
| tagged-pdf | 2 | 6 | **5** | 6 | 2 | 2/2 |
| shared-form-xobject | 3 | 9 | **7** | 3 | 3 | 3/3 |
| benchmark | 2 | 6 | 6 | 6 | 2 | 2/2 |
| **합계** | **19** | **53** | **50** | 31 | 19 | 19/19 |

- 표 중심 재무 문서는 본문 문단이 적어 MTS·H.4.1 에서 1개씩만 선택됐다(탈락 사유 대부분 `too-few-lines`·`low-letter-ratio`). 표 셀 교체는 이번 범위가 아니다(문단만).
- 한글 문장 교체 대상 중 원 문단이 한글(한글 비율 > 0.5)인 것은 8/53 이다(나머지는 영문 문단을 한글로 교체).

### 2.3 결과: 문서별

| id | 선택 쪽(경로) | 성공 | 실패 | 관찰(실패 아님) | 편집 제한·경고 | subset ms | 저장 ms | 편집 프로세스 힙 MiB |
|---|---|---|---|---|---|---|---|---|
| zen-ko-kimtw-23386644 | 16·17·18(줄 병합) | 3/3 | - | glyph-aa, poppler-raster | tagged ×3 | 53 | 38 | 33.1 |
| zen-ko-sim-21496576 | 8·25·41 | 3/3 | - | poppler-raster, word-subpt-shift | link-removed ×1 | 101 | 12 | 45.8 |
| zen-ko-moon-21973474 | 5·17·6(줄 병합) | 3/3 | - | glyph-aa | - | 72 | 16 | 26.4 |
| nist-ai-100-1 | 8·24·40 | 3/3 | - | poppler-raster | link-removed ×1 | 30 | 7 | 31.8 |
| nist-cswp29 | 5·17·6 | 3/3 | - | poppler-raster | tagged ×3 | 40 | 15 | 45.8 |
| nasa-eo-2019-maraprl | 6·20·34 | 3/3 | - | poppler-raster | tagged ×3, form-instancing ×3 | 120 | 57 | 54.9 |
| nasa-eo-2024-janfeb | 5·17·29 | 3/3 | - | glyph-aa, poppler-raster | tagged ×3, form-instancing ×3, link-removed ×1 | 32 | 40 | 55.6 |
| ustreas-mts-202509 | 39 | 1/1 | - | glyph-aa, outside-aa, poppler-raster | tagged ×1, form-instancing ×1, link-removed ×1 | 272 | 54 | 45.8 |
| fed-h41-current | 10 | 1/1 | - | glyph-aa, poppler-raster | - | 39 | 9 | 27.9 |
| fed-combined-finstmt-2025 | 10·32·53(줄 병합) | 3/3 | - | poppler-raster | tagged ×3 | 184 | 143 | 85.2 |
| arxiv-2609.09268 | 3·15·4 | 3/3 | - | poppler-raster, word-subpt-shift | form-instancing ×1, link-removed ×1 | 62 | 11 | 22.0 |
| arxiv-2609.10511 | 3·4·6 | 3/3 | - | poppler-raster | - | 53 | 69 | 26.4 |
| nist-sp800-171r3 | 18·60·103 | 3/3 | - | poppler-raster | tagged ×3, link-removed ×1 | 146 | 56 | 26.4 |
| zen-ko-report-21333257 | 23·76·129(줄 병합) | **2/3** | 23쪽: outside-diff(redaction·content·reopen), poppler-word-shift | glyph-aa, poppler-raster, word-subpt-shift | tagged ×3, form-instancing ×3 | 113 | 200 | 54.9 |
| zen-beamer-10545284 | 9·27·51 | **1/3** | 9·51쪽: poppler-word-lost | poppler-raster, word-subpt-shift | form-instancing ×2 | 114 | 13 | 26.4 |
| zen-beamer-7535020 | 14·44·69 | 3/3 | - | - | form-instancing ×3, link-removed ×1 | 95 | 27 | 54.9 |
| nasa-eo-2023-sepoct | 10·32·53 | 3/3 | - | poppler-raster | tagged ×3, form-instancing ×3, link-removed ×1 | 43 | 83 | 54.9 |
| nist-sp800-53r5 | 74·246·421 | 3/3 | - | glyph-aa, poppler-raster | tagged ×3, link-removed ×1 | 845 | 216 | 73.2 |
| nasa-se-handbook-sp2016-6105 | 45·149·252 | 3/3 | - | glyph-aa, poppler-raster | tagged ×3, form-instancing ×3, L2 ×2 | 292 | 444 | 122.9 |

공통 결과(53문단)

| 측정 | 결과 |
|---|---|
| 대상 문단 제거(redaction 직후·재열기) | 53/53 · 53/53 |
| 인접 텍스트 손실(redaction 직후·재열기) | 0/53 · 0/53 |
| 교체 문장 재추출·검색어 2개 적중(MuPDF) | 53/53 |
| 배치: 원 문단 줄 수 이내·넘침 | 53/53 · 넘침 0(자동 클립 없음) |
| 폴백 폰트 글리프 누락 | 0 |
| 참조 렌더 대비 96단계 초과 차이 | 0/53(엄격 0 px 는 40/53, 나머지 13건 최대 1~66단계) |
| 편집 영역 밖 96단계 초과 차이(MuPDF) | 52/53 무차이(엄격 0 px 51/53) |
| 재열기 렌더 = 저장 전 렌더 | 53/53 |
| 편집하지 않은 첫·마지막 쪽(MuPDF) | 37/37 쪽 0 px |
| 재열기 폰트 객체 | 19/19 `Type0`/`CIDFontType2`/`FontFile2` 서브셋(약 107 KB)/ToUnicode 있음 |
| Poppler 텍스트·검색어 | 53/53 · 53/53. `pdffonts` NotoSansKR emb/sub/uni yes 19/19 |
| Poppler 편집 영역 밖 단어 | 손실 2문단(beamer), 0.5pt 초과 이동 1문단(zen-ko-report). 렌더 엄격 0 px 15/53, 96단계 초과 없음 45/53 |
| `canBeSavedIncrementally()` | 19/19 열기 직후 true → 편집 후 false, 저장 방식 전체 19/19 |
| MuPDF 경고·오류 | 8문서: `Font cannot be both symbolic and non-symbolic. Skipping subsetting.`(2), `Invalid offsize in CFF`(arXiv 2), `ActualText with no position. Text may be lost or mispositioned.`(2), `PDF stream Length incorrect`(1), `closepath with no current point`(1) |

### 2.4 실패 3건 원인

| 문단 | 실패 | 원인(근거) |
|---|---|---|
| zen-ko-report 23쪽 | 편집 영역 밖 MuPDF 96단계 초과 9,605 px(최대 187단계), Poppler 단어 최대 3.137pt 이동 | 같은 쪽 다른 글머리 문단의 첫 줄(글머리 기호 + 탭 글자 `/Span <</ActualText <FEFF0009>>>`) 다음 텍스트가 오른쪽으로 밀림(확대 비교). MuPDF 가 이 문서 편집 중 `ActualText with no position. Text may be lost or mispositioned.` 경고. `subsetFonts()` 생략 대조에서도 동일(3.137pt) → **redaction 재직렬화 원인**(C2). 텍스트 손실은 없음 |
| zen-beamer-10545284 9·51쪽 | Poppler 단어 손실 1개씩 | 쪽 왼쪽 가장자리(x 0–25.5pt)에 걸친 `@MartinOlalla` 1단어가 편집 후 Poppler 추출에서 빠짐. 27쪽은 반대로 편집 후 새로 추출됨. MuPDF 추출·렌더는 변화 없음(인접 손실 0, 밖 0 px) → Poppler 의 쪽 경계 단어 추출 차이로 판단(추정). 실패 집계는 유지 |

### 2.5 관찰(실패로 세지 않음)

| 관찰 | 건수 | 내용 |
|---|---|---|
| poppler-raster-diff | 38문단 | Poppler 편집 영역 밖 렌더가 엄격 기준으로 다름. 대부분 최대 64~66단계(1/4 px 원점 양자화 수준). 96단계 초과가 있는 8문단(nasa-eo-2023·2024, fed-combined, arXiv-10511 ×2, NIST 171 ×2, zen-ko-report) 중 zen-ko-report 외에는 단어 이동 0.000pt 이며 `subsetFonts()` 생략 대조에서도 같은 값 → 재직렬화된 경로·글리프 원점의 미세 차이로 판단(추정) |
| poppler-word-subpt-shift | 10문단 | pdfTeX 문서(zen-ko-sim 0.132pt, arXiv 0.089pt, beamer 0.072pt)에서 편집 영역 밖 단어가 0.01~0.13pt 이동. **서브셋 생략 대조에서 0** → C1 원인 |
| mupdf-glyph-aa-diff | 13문단 | 참조 렌더와 엄격 차이 있으나 96단계 이하(최대 1~66) |
| mupdf-outside-aa-diff | 1문단 | MTS 39쪽 편집 영역 밖 57 px, 최대 66단계 |

### 2.6 `subsetFonts()` 대조 실행(C1)

같은 19건을 저장 전 `subsetFonts()` 없이 실행(`out/m0-corpus-nosubset`).

| 측정 | subsetFonts() 호출 | 생략 |
|---|---|---|
| Poppler 편집 영역 밖 단어 최대 이동 | zen-ko-sim 0.132pt, arXiv-09268 0.089pt, beamer 0.072pt | 0.000 / 0.001 / 0.000pt |
| pdf.js 편집하지 않은 쪽(첫·마지막) 렌더 차이 | zen-ko-sim 48,254·16,403 px, arXiv-09268 182,301·128,113 px | 0 · 0 |
| 편집 없이 `subsetFonts()`+저장만(Poppler 1쪽) | arXiv-09268 38,224 px(96단계 초과 179), zen-ko-sim 14,154 px(208), NIST·Word 문서 0 | 0 |
| zen-ko-report 3.137pt 이동 | 있음 | 있음(C2 는 별개) |
| 저장 크기 | 기준 | +0.9~2.6 MB(폴백 폰트 2.56 MB 전체 포함) |

- 원인: `subsetFonts()` 가 원본 Type1 폰트 `/Widths`(간접 배열)를 인라인 정수 배열로 다시 쓴다. arXiv-09268 F32(CMR10): 126개 중 101개 변경, 44개는 0(미사용), 57개는 반올림(833.3→833, 555.6→556, 277.8→278). Poppler·pdf.js 는 `/Widths` 로 글자 간격을 정하므로 줄을 따라 위치가 누적 이동한다. MuPDF 는 렌더 0 px 차이.
- 폴백 폰트만 서브셋하는 수단이 필요하다(8절 A7-1). 서브셋을 생략하면 문서마다 2.5 MB 가 붙어 v1 에 쓸 수 없다.

### 2.7 편집 제한 판정 집계(53문단)

| 판정 | 문단 | 내용 |
|---|---|---|
| tagged(limit) | 31 | 태그 PDF 이고 편집 쪽 콘텐츠에 MCID 있음 → PLAN.md 1.4 태그 정책 대상. 코퍼스 태그 문서 11/19, MCID 연산 94,616개 |
| form-instancing(warn) | 22 | 편집 쪽에 Form 사용 위치가 있어 페이지 redaction 시 모두 인스턴스화(A1-1) |
| link-removed(warn) | 9 | 편집 영역의 링크가 redaction 으로 제거(A2-1) |
| L2(limit) | 2 | 문단과 겹치는 텍스트 Form 에 `/StructParents`(NASA SE 핸드북) |
| L1·L5·L6·L7(문단과 겹친 Form) | 0 | - |
| existing-redact | 0 | 코퍼스에 기존 Redact 주석 없음(0/19). 합성 픽스처 결과만 있음 |
| font-mapping·unmapped-text | 0 | 선택 문단 글꼴 중 ToUnicode 없는 비표준 인코딩 0, 추출 문자 U+FFFD·PUA 0 |

### 2.8 저장 시간·피크 WASM 힙·`decideSaveMethod` 판정

편집 프로세스(문단 1~3개 편집 + 검증 렌더 포함) 기준: 전체 저장 7~444 ms, `subsetFonts()` 30~845 ms(492쪽 NIST 845 ms 로 저장보다 길다), 저장 후 WASM 힙 22.0~122.9 MiB. `decideSaveMethod`(배율 4.48) 예측 수준은 19/19 `ok`, 실제(상한 2 GiB 대비 1.1~6.0%)도 19/19 `ok` → 미탐 0, 일치 19/19. 단 코퍼스 최대 파일이 11.3 MiB 라 `warn`(> 342.9 MiB)·`over-limit` 경계는 실제 문서로 검증되지 않았다.

순수 저장 벤치마크(검증 렌더 없이 1쪽 Day 1 편집 후 전체 저장, `--child save:buffer-compact|stream-compact`, 합성 벤치마크와 같은 코드):

| id | 파일 MiB | 쪽 | Buffer: 열기 후 / 저장 전 / 저장 후 힙 MiB | 저장 증가분 MiB(÷파일) | Stream 저장 후 MiB | 저장 ms |
|---|---|---|---|---|---|---|
| nasa-se-handbook-sp2016-6105 | 3.6 | 297 | 22.0 / 26.4 / 95.0 | 68.6 (19.1×) | 90.8 | 657 |
| zen-ko-report-21333257 | 2.5 | 152 | 22.0 / 31.8 / 54.9 | 23.2 (9.2×) | 54.9 | 201 |
| nasa-eo-2023-sepoct | 5.0 | 63 | 22.0 / 22.0 / 38.1 | 16.1 (3.3×) | 31.8 | 80 |
| nist-sp800-171r3 | 1.5 | 120 | 22.0 / 22.0 / 26.4 | 4.4 (2.9×) | 26.4 | 56 |
| zen-beamer-7535020 | 11.3 | 81 | 22.0 / 26.4 / 54.9 | 28.5 (2.5×) | 37.1 | 26 |
| nasa-eo-2024-janfeb | 6.5 | 34 | 22.0 / 22.0 / 38.1 | 16.1 (2.5×) | 31.8 | 48 |
| nasa-eo-2019-maraprl | 6.0 | 40 | 22.0 / 31.8 / 45.8 | 14.0 (2.3×) | 38.1 | 61 |
| fed-combined-finstmt-2025 | 4.1 | 63 | 22.0 / 38.1 / 45.8 | 7.6 (1.9×) | 45.8 | 150 |
| nist-sp800-53r5 | 5.8 | 492 | 22.0 / 65.9 / 65.9 | 0.0(저장 전 +43.9) | 65.9 | 219 |
| 나머지 10건 | 0.2~3.8 | 11~54 | 22.0~45.8 | 0~6.4 (≤ 1.8×) | 22.0~38.1 | 6~50 |

- 38회 실행 모두 성공. 실제 문서는 저장(또는 저장 전 subset) 단계의 힙 증가가 파일 크기에 비례하지 않는다: 압축률이 높고 객체가 많은 문서(297쪽 3.6 MiB)에서 증가분이 파일의 19.1배. 합성 문서(잡음 이미지 위주)는 1.5~3.2배였다(`docs/m0-dod-xobject-redact-save.md` 3.3).
- 작은 문서는 기본 힙 22 MiB 가 커서 배율이 크게 보인다(H.4.1 0.2 MiB → 배율 120). 판정은 맞지만 배율 모델 자체는 실제 문서에 맞지 않는다(C4, A3-5).
- Stream 입력은 실제 문서에서도 저장 후 힙이 같거나 작았다(최대 17.8 MiB 감소, zen-beamer-7535020).

### 2.9 공유 Form XObject 정책 경로(실제 문서, A1-2)

텍스트가 있는 공유 Form(사용 2곳 이상) 상위 2개마다 첫 사용 위치 1곳만 `redactFormUsage`(임시 페이지 redaction)로 새 인스턴스로 바꿔 Form BBox 안 텍스트를 지우고 한글 한 줄을 넣었다(`corpus-xobject.ts`, Form 마다 새로 열어 독립 실행).

| 문서 · Form | 사용 위치 | 내용 | BBox 정규화 | 선택 쪽 사용 위치 밖 / 같은 Form 다른 쪽 렌더 | 재열기 검색 | 새 줄 추출 | 판정 |
|---|---|---|---|---|---|---|---|
| nasa-eo-2024 #268 | 32 | 러닝헤드 | 아니오 `[0 792 612 0]` | 0 / 0·0·0 px | 1 | 예 | 통과 |
| zen-ko-report #357 | 2 | 한글 러닝헤드 | 아니오 | 0 / 0 px | 1 | 예 | 통과 |
| zen-ko-report #389 | 3 | 한글 러닝헤드 | 아니오 | 0 / 0·0 px | 1 | 예 | 통과 |
| zen-beamer-10545284 #673 | 4 | 삽입 PDF 그림(중첩 깊이 2) | 예 | 0 / 0·0·0 px | 1 | **아니오** | 배치 실패 |
| zen-beamer-10545284 #182 | 4 | 삽입 PDF 그림 | 예 | 0 / 0·0·0 px | 1 | 예 | 통과 |
| zen-beamer-7535020 #123 | 3 | 삽입 PDF 그림 | 예 | 0 / 0·0 px | 1 | 예 | 통과 |
| nasa-eo-2023 #301 | 58 | 러닝헤드 | 아니오 | 0 / 0·0·0 px | 1 | 예 | 통과 |
| nasa-se 핸드북 #851 | 6 | 머리말(L2 `/StructParents`) | 예 | 0 / 0·0·0 px | 1 | 예 | 통과 |
| nasa-se 핸드북 #857 | 41 | 쪽 틀(L2) | 예 | 0 / 0·0·0 px | 1 | **아니오** | 배치 실패 |

- 정책 조건(선택 사용 위치만 바뀌고 같은 쪽 나머지·같은 Form 을 쓰는 다른 쪽은 렌더 불변, 저장 후에도 동일)은 **9/9** 충족했다. 새 줄 추출 실패 2건은 스파이크의 배치 규칙(Form BBox 왼쪽 위) 문제다. #857 은 BBox(페이지 공간 y −14.7~795.8)가 CropBox(576×756)보다 커서 새 줄이 쪽 표시 영역 밖(y −39.6)에 놓여 stext 에서 빠졌다(확인). #673 은 같은 원인으로 추정(미확인). MuPDF 검색은 쪽 밖 글자도 찾아 1건으로 나왔다.
- 정규화되지 않은 BBox 4/9: `pdf-ops` `outsideFormBBox` 가 4/4 를 "BBox 밖" 으로 오판(결과 `pdfOpsOutsideFormBBox`). 스파이크는 정규화해 판정했다(C3).
- 이 경로의 L 조건 실측: L2 2/9(NASA SE 핸드북), L1·L5·L6·L7 0/9.

## 3. pdf.js 독립 확인(V3 대체)

### 3.1 방법

| 항목 | 내용 |
|---|---|
| 도구 | npm `pdfjs-dist` **6.4.299**(build d0991a0d5), legacy 빌드를 Node 22.18.0 에서 실행, 렌더는 pdf.js Node 캔버스 팩토리(`@napi-rs/canvas` 1.0.11). **Firefox 브라우저 결과가 아니다** |
| 실행 | `pnpm --filter @pdf-editor/spike-m0 spike:pdfjs` → `out/m0-corpus/pdfjs-result.json`, 편집 쪽 렌더 PNG `out/m0-corpus/pdfjs/` |
| 판정 | (1) 편집 쪽 `getTextContent`(공백 제거)에 교체 문단 전문 (2) 지운 원 문단 줄의 등장 횟수 감소(원본 pdf.js 추출에 그대로 없는 줄은 판정 제외, 6줄) (3) 검색어 포함(pdf.js 찾기와 같은 공백 정규화 문자열 검색) (4) 편집 영역 밖 텍스트 글자 구성 동일 (5) 편집하지 않은 쪽 렌더 0 px. 편집 영역 밖 렌더 차이와 편집 영역 잉크비(pdf.js ÷ 같은 배율 MuPDF, 글리프 미표시 감지용)는 기록 |
| 테스트 | `tools/spike-m0/test/corpus.test.ts` 가 fixtures/m0 3개를 같은 기준으로 확인 |

### 3.2 fixtures/m0 편집 결과 3개

| 파일 | 교체 문단 | 원 문단 제거 | 검색어 | 편집 영역 밖 렌더 | 다른 쪽 | 잉크비 | 판정 |
|---|---|---|---|---|---|---|---|
| `m0-spike-saved.pdf` | 1/1 | 2/2 | 4/4(`한글`·`폴백 폰트`·`임베딩`·`검색과 복사`) | 0 px | 해당 없음 | 1.12 | 통과 |
| `m0-shared-xobject-edited.pdf` | 2/2(카드 문단·중첩 배지) | 해당 없음(A 위치 원문 유지가 정상) | 2/2 | 0 px(B 사용 위치 밖) | 2쪽 0 px | 1.04 | 통과 |
| `m0-preexisting-redact-edited.pdf` | 2/2(새 문단·R1 아래 인접 문단) | 2/2 | 4/4 | 0 px | 2쪽 0 px | 1.18 | 통과 |

- pdf.js 는 Redact 주석에 `Unimplemented annotation type "Redact", falling back to base annotation.` 경고를 낸다(원본·편집 결과 공통). 외관 스트림을 그대로 그리므로 편집 영역 밖 렌더는 원본과 같았다.

### 3.3 코퍼스 편집 결과 19개

| 결과 | 문서 |
|---|---|
| 통과 17 | (19문서 53쪽 전체 기준) 교체 문단 53/53 쪽 추출, 검색어 53/53, 원 문단 제거 판정 281/281 줄(판정 제외 6줄), 편집 영역 밖 텍스트 글자 구성 53/53 동일, 잉크비 1.00~1.11 |
| 불일치 2 | zen-ko-sim·arXiv-09268: 위 항목은 모두 통과했으나 **편집하지 않은 첫·마지막 쪽 렌더가 다름**(48,254·16,403 / 182,301·128,113 px). `subsetFonts()` 생략 대조에서 0 → C1 |

- 편집 영역 밖 렌더(관찰): 엄격 0 px 는 11/53 쪽이며, 96단계 초과는 zen-ko-report 23쪽 9,353 px(C2 와 같은 위치), zen-ko-sim 8 px, arXiv-09268 10 px. pdf.js 판정은 텍스트 기준이라 zen-ko-report 23쪽 위치 이동(C2)은 MuPDF·Poppler 판정으로만 실패 처리된다.
- 서브셋 생략 대조(`out/m0-corpus-nosubset/pdfjs-result.json`): 22/22 통과.

## 4. Chrome 128–150 DNR 경로 실측(A5)

### 4.1 방법

| 항목 | 내용 |
|---|---|
| 브라우저 | Chrome for Testing 공식 배포(googlechromelabs known-good-versions) linux64. 128.0.6613.137 · 140.0.7339.207 · 149.0.7827.155 · 150.0.7871.124 전체 측정, 145.0.7632.117 · 147.0.7727.117 · 148.0.7778.178 · 150.0.7828.0 · 150.0.7871.0 은 `chrome.mimeHandler` 유무만 확인. 저장 위치 `~/.cache/pdf-editor/chrome-for-testing/`(저장소 밖) |
| 내려받기 | `node apps/extension/scripts/fetch-chrome-for-testing.mjs 128 140 149 150` |
| 실행 | `PDF_EDITOR_LEGACY_CHROME=<실행 파일>,… pnpm --filter @pdf-editor/extension exec playwright test dnr-legacy`(`apps/extension/e2e/dnr-legacy.spec.ts`). Playwright 1.64.1 `launchPersistentContext({executablePath})`, `--headless=new`(131 이하에서 `--headless` 가 구 headless 일 수 있어 직접 지정), `--load-extension=dist`. 기본 `test:e2e` 에서는 건너뜀 |
| 확장 | 현재 `apps/extension/dist`(manifest `minimum_chrome_version` 128, `mime_types_handler` + DNR 동적 규칙 폴백). 확장 코드 변경 없음 |
| 파일 URL 접근 | 압축해제 확장의 기본값(측정: 켜짐)으로 측정 → `chrome.developerPrivate.updateExtensionConfiguration` 으로 끈 뒤 재측정 |
| 결과 원본 | `out/m0-corpus/dnr/<버전>.json` |

### 4.2 결과(서버 헤드리스)

| 항목 | 128.0.6613.137 | 140.0.7339.207 | 149.0.7827.155 | 150.0.7871.124 |
|---|---|---|---|---|
| `chrome.mimeHandler` | 없음 | 없음 | 없음 | **있음** |
| 서비스 워커 판정 | `dnr-fallback` | `dnr-fallback` | `dnr-fallback` | `mime-handler` |
| 동적 규칙 | 1001·1002 | 1001·1002 | 1001·1002 | 0개 |
| 설치 경고(`mime_types_handler` 등) | 없음 | 없음 | 없음 | 없음 |
| http 최상위 GET PDF | DNR 리다이렉트 → `viewer.html?file=…`, 배지 `url-param`, 렌더. 서버 GET 2회(원 요청 + 뷰어 재요청) | 동일 | 동일 | `mime-handler-top`, 렌더, GET 1회 |
| `content-type: application/pdf; qs=0.001` | 리다이렉트·렌더, GET 2회 | 동일 | 동일 | `mime-handler-top`, GET 1회 |
| `content-disposition: attachment` | 다운로드(가로채지 않음) | 동일 | 동일 | 다운로드 |
| POST 응답 PDF | 가로채지 않음(GET 전용 규칙). 확장 뷰어 없음, Chrome 기본 뷰어(추정: `about:blank` 하위 프레임) | 동일(추정) | 가로채지 않음, Chrome 기본 뷰어(`mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html` 프레임 확인) | `mime-handler-top` 렌더, POST 1회 |
| http 페이지 `<embed>`·`<iframe>`·`<object>` | 1개만 `url-param`(규칙 `resourceTypes` 가 `main_frame`·`sub_frame` 이라 iframe 만 해당), 2개는 Chrome 기본 뷰어(추정) | 동일 | 동일(기본 뷰어 프레임 2개 확인) | 3개 모두 `mime-handler-embedded` |
| file://(파일 URL 접근 켬 = 기본값) | 리다이렉트 → `url-param`, 렌더(뷰어가 file:// fetch 성공) | 동일 | 동일 | `mime-handler-top`, 렌더 |
| file://(파일 URL 접근 끔) | 리다이렉트 없음 → Chrome 기본 뷰어(추정) | 동일(추정) | 리다이렉트 없음 → Chrome 기본 뷰어(확인) | `mime-handler-top`, 렌더(설정 무관) |

- `chrome.mimeHandler` 도입 경계: 145·147·148·149 없음, 150.0.7828.0(150 첫 CfT 빌드) 없음 → **150.0.7871.0(150 분기) 있음**, 150.0.7871.124 있음. Chrome for Testing 기준 공개 MIME handler 는 **150 안정판부터** 동작하고 DNR 폴백이 실제로 쓰이는 범위는 **128–149** 다. 정식 Chrome 150 은 Finch(필드 트라이얼) 설정이 CfT 와 다를 수 있어 미확인.
- 128·140 의 "Chrome 기본 뷰어" 는 확장 뷰어 프레임이 없고 PDF 프레임 아래 `about:blank` 하위 프레임이 생긴 것으로 판단한 추정이다. 149 는 기본 PDF 뷰어 확장 URL 프레임이 직접 보였다.
- DNR 경로는 리다이렉트 후 뷰어가 원 URL 을 다시 받는다(GET 2회 실측). POST·일회성 URL 은 가로채지 않거나(POST) 재요청이 실패할 수 있다는 PLAN.md 5.1 의 제한을 실측으로 확인했다.
- 개발자 모드: 새 프로필의 개발자 모드는 꺼져 있다(측정). 140·150 은 개발자 모드가 꺼진 상태에서 파일 URL 접근 설정을 바꾸면(확장 재로드) 확장을 `DISABLED`(`unsupportedDeveloperExtension`)로 바꿨다. 128 은 그대로 동작했다. 측정은 개발자 모드를 켠 뒤 수행했다. 압축해제 설치의 사용 조건이며 Web Store 설치와는 무관하다.

## 5. M0 DoD 판정

| DoD 항목(PLAN.md 6절) | 판정 | 근거 |
|---|---|---|
| 텍스트 교체: 기존 문단 제거, 새 문단 중복 없이 표시 | **통과** | 합성 4종 통과(Day 1·DoD 문서). 실제 코퍼스 53/53 문단 대상 제거·새 문단 1회 추출(재열기 포함), 넘침 0 |
| 새 한글 입력: 원본 서브셋에 없는 글자가 폴백 임베딩으로 저장 후 정상 표시 | **통과** | 19/19 문서 Noto Sans KR glyf 서브셋 임베딩(Type0/CIDFontType2/FontFile2 약 107 KB, ToUnicode), 글리프 누락 0, 참조 렌더 96단계 초과 차이 0/53, Poppler emb/sub/uni 19/19, pdf.js 잉크비 1.00~1.18 |
| 주변 보존: 표 선·배경·인접 텍스트 변화 없음 | **제한** | 인접 텍스트 손실 0/53, 편집 영역 밖(MuPDF) 52/53. 실패 1건: redaction 재직렬화로 같은 쪽 다른 문단 첫 줄 최대 3.1pt 이동(C2). 또 `subsetFonts()` 가 원본 폰트 `/Widths` 를 다시 써서 pdfTeX 문서의 편집하지 않은 쪽이 Poppler·pdf.js 에서 바뀜(C1). 둘 다 M1 에서 해소 필요 |
| 저장 후 재열기: Chrome 과 다른 뷰어 정상 표시 | **제한** | Chrome 155 기본 뷰어(fixtures/m0 3개, 사용자 보고), PDFium 156(측정, Day 1 9.3), Poppler 22.02(코퍼스 19), pdf.js 6.4.299 pdfjs-dist(22쌍 중 20, 실패 2건은 C1). Acrobat 미확인. 코퍼스 결과의 Chrome 표시는 미확인 |
| 텍스트 의미 보존: 검색·복사·재추출 일치 | **통과(엔진 기준) / 제한(확장 뷰어)** | 재추출·검색: MuPDF 53/53, Poppler 53/53, pdf.js 53/53 쪽. 복사는 Chrome 기본 뷰어(fixtures/m0, 사용자 보고)만 확인. 확장 뷰어는 텍스트 선택 층이 없어 검색·복사 불가(M1 작업) |
| 저장 방식: redaction 후 `canBeSavedIncrementally()` 확인, 전체 저장 피크 메모리·시간 측정 | **통과(서버) / 제한(브라우저·대형 실제 문서)** | 19/19 열기 true → 편집 후 false, 전체 저장 19/19. 저장 7~657 ms, 힙 22~123 MiB, 판정 미탐 0/19. 실제 문서 증분 배율 최대 19.1×(C4), 100 MB 이상 실제 문서 미측정, Windows Chrome Worker 미측정(A3-4) |
| 첫 저장·재저장(세 문맥 FSA) | **제한(미확인 잔여)** | 이번 작업 범위 밖. Day 1 9.4: F1·F2 통과, 임베디드 문맥 F3 의 Ctrl+S 재저장·fsaError 미확인 |
| 공유 XObject: 복제 후 수정 정책 동작 | **통과(정책) / 제한(배치·BBox)** | 합성 3종 통과. 실제 6문서 9개 Form: 선택 위치 밖·같은 Form 다른 쪽 렌더 0 px 9/9, 재열기 검색 9/9. 새 줄 배치 7/9(BBox ⊄ CropBox, C6), 정규화 안 된 BBox 4/9 에서 `outsideFormBBox` 오판(C3) |
| 가로채기: 151+ mimeHandler, 128–150 DNR(file:// 포함) | **통과(실측 완료, 경계 정정 필요)** | MIME handler: Windows Chrome 155(Day 1 9절) + CfT 150. DNR: CfT 128·140·149 에서 http GET·content-type 매개변수·file://(파일 URL 접근 켬) 동작, attachment·POST·embed/object·file://(접근 끔)는 가로채지 않음. 실제 경계는 150(151 아님). Windows 정식 Chrome 128–149 미확인 |

## 6. M1 재산정 입력 수치

### 6.1 원본 연결(SourceMap) 매칭 난이도 근거(19문서·1,647쪽)

| 항목 | 값 | 의미 |
|---|---|---|
| 쪽 콘텐츠 토크나이저 실패(L6) | 0/1,647쪽 | `pdf-ops` 토크나이저는 실제 코퍼스 전부 통과 |
| Contents 배열 경계에 걸친 연산자 | 0쪽(Contents 다중 스트림 쪽 5) | L6 후반부 실측 빈도 0 |
| 텍스트 표시 연산(Tj/TJ/'/") 위치 | 쪽 콘텐츠 321,653 · Form 안 5,257(1.6%) | 텍스트 대부분은 쪽 콘텐츠. 다만 Form 안 텍스트가 있는 쪽 618/1,647(37.5%, 대부분 러닝헤드) |
| Form XObject | 사용 2,970 · 고유 293 · 공유 149 · 텍스트 포함 118 · 공유+텍스트 32(6문서) · 최대 깊이 2 | 재귀 깊이 상한 8 은 충분 |
| L1(자체 Resources 없음) | 86 Form(전부 arXiv-09268, 텍스트 없음) | A1-3: 실제 문서에 존재하나 이번 코퍼스에서는 텍스트 Form 아님 |
| L2 / L5 / L6 / L7 | 13 / 0 / 0 / 4 Form | L2 는 태그 문서 러닝헤드 |
| 정규화 안 된 Form BBox | 시험한 9개 중 4개 | 사각형 정규화 필수(C3) |
| 폰트 | 1,244개: Type1 702, Type0 431(Identity-H 431), TrueType 72, Type3 39(4문서) | Type3 4/19 문서 |
| ToUnicode 없음 / 매핑 위험(ToUnicode 없는 비표준 인코딩·Type3) | 207(16.6%) / 50(4문서) | 선택 문단 중 매핑 위험 0/53. 문자 코드↔유니코드 매칭은 대부분 ToUnicode·표준 인코딩으로 가능 |
| `/Differences` 단순 폰트 | 331 | 코드→글리프 이름 매핑 처리 필요 |
| 태그 | StructTreeRoot 11/19 문서, MCID 94,616개, 편집 문단 31/53 이 MCID 쪽 | 태그 정책(1.4) 기본 동작이 v1 사용 범위를 좌우 |
| 링크 주석 | 10,866개, 편집 문단 9/53 에서 제거 | A2-1(링크 복원) 우선순위 근거 |
| stext 블록 ≠ 문단 | 한 줄 블록 비율 0.21~1.0(5/19 문서가 0.7 이상), 선택 문단 12/53 은 줄 병합으로만 가능 | M2 레이아웃 복원의 줄 병합 필수 |
| 같은 쪽 같은 문장 중복 | 공유 Form·러닝헤드에서 발생(합성·실제) | 텍스트 기반 매칭은 등장 위치까지 구분해야 함 |
| redaction 재직렬화 | 쪽 콘텐츠 전체 재작성(arXiv: 연산자 906→2,069, `Td`→`TD`, 중복 `G` 14→1,179, 바이트 +37%), 원본 바이트 위치 소실 | 편집 후 SourceMap 재생성 필요. 원본 연산자 바이트 범위만 지우는 자체 편집 경로를 검토(A7-2) |
| redaction 시 MuPDF 경고 | `ActualText with no position` 2/19 문서(1문서 가시 이동 3.1pt) | 재직렬화 결함 감지 신호 |

### 6.2 성능·메모리

| 항목 | 값 |
|---|---|
| 열기(Buffer) | 3~21 ms(492쪽 21 ms) |
| 문단 1개 redaction | 최대 49 ms |
| `subsetFonts()` | 30~845 ms(문서 전체 폰트 처리, 492쪽에서 저장보다 김) |
| 전체 저장 | 7~657 ms(297쪽 3.6 MiB 최대) |
| 저장 피크 WASM 힙(순수 저장) | 22.0~95.0 MiB(Buffer), 저장 증가분 파일의 0~19.1배 |
| 분석(구조+문단 선택) | 최대 79 MiB 힙 |

### 6.3 작업량 추가 근거(재산정 시 반영 후보)

| 마일스톤 | 항목 | 근거 |
|---|---|---|
| M1 | 폴백 폰트만 서브셋(JS 서브셋 또는 subset 후 원본 폰트 복원) | C1, pdfTeX 문서 2/19 에서 미편집 쪽 변화 |
| M1 | 텍스트 제거를 MuPDF 페이지 redaction 대신 SourceMap 기반 연산자 제거로 할지 결정(재직렬화·ActualText 이동 회피) | C2, 6.1 |
| M1 | `pdf-ops` 사각형 정규화(`toRect`·`outsideFormBBox`·사용 위치 pageBox) | C3 |
| M2 | stext 줄 병합 문단 복원(Word·InDesign·한컴 출력) | C5, 12/53 |
| M3 | Form 인스턴스·문단 배치 영역 = 원 텍스트 위치 ∩ BBox ∩ CropBox | C6 |
| M3 | 태그 PDF 기본 동작(31/53 문단이 MCID 쪽) | 2.7 |
| M5(앞당김 검토) | 저장 힙 예측 모델에 객체 수·디코드 크기 항, 100 MB 이상 실제 문서 측정 | C4 |

## 7. 문제·발견

| # | 내용 | 근거(실측) | 처리 |
|---|---|---|---|
| C1 | MuPDF 1.28.1 `subsetFonts()` 가 원본 단순 폰트 `/Widths` 를 정수 반올림·미사용 0 으로 다시 씀 | 편집 없이 `subsetFonts()`+저장만으로 arXiv-09268 1쪽 Poppler 38,224 px(96단계 초과 179), zen-ko-sim 14,154 px. NIST·Word·InDesign 문서는 0. 같은 저장에서 MuPDF 경고 `Font cannot be both symbolic and non-symbolic. Skipping subsetting.`(2문서), `Invalid offsize in CFF`(arXiv 2) | A7-1. 현재 스파이크·`core` 저장 경로 모두 `subsetFonts()` 사용 |
| C2 | 페이지 redaction 재직렬화가 `ActualText` Span 이 있는 줄의 위치를 바꿈 | zen-ko-report 23쪽: 다른 글머리 문단 첫 줄 최대 3.137pt 이동(Poppler 단어 비교), MuPDF 96단계 초과 9,605 px, MuPDF 경고 `ActualText with no position`. 서브셋 생략 대조에서도 동일 | A7-2 |
| C3 | 실제 Form `/BBox` 비정규화 | nasa-eo #268·#301, zen-ko-report #357·#389 `[0 792 612 0]` 형태. `outsideFormBBox` 4/4 오판 | A7-3(`pdf-ops` 담당 세션) |
| C4 | 저장 힙이 파일 크기에 비례하지 않음 | 순수 저장 증가분 최대 19.1×(합성 1.5~3.2×). 판정은 19/19 맞음(전부 소형) | A7-5 |
| C5 | stext 블록이 줄 단위인 출력기 | 한 줄 블록 비율 kimtw 1.0, zen-ko-report 0.89, beamer 0.80, fed-combined 0.78 | A7-6 |
| C6 | 공유 Form BBox 가 CropBox 보다 큼 | nasa-se #857 BBox y −14.7~795.8, 쪽 576×756, 새 줄 y −39.6 | A7-4 |
| C7 | 측정 도구: Poppler 쪽 경계 단어 추출 불안정 | beamer `@MartinOlalla`(x 0–25.5pt) 9·51쪽 소실·27쪽 출현, MuPDF 무변화 | A7-9 |
| C8 | Chrome 150 안정판부터 공개 MIME handler | CfT 150.0.7871.0 이상 `chrome.mimeHandler` 있음, 150.0.7828.0·149 없음 | A5-1 |
| C9 | DNR 폴백은 embed·object 를 가로채지 않음 | 규칙 `resourceTypes` main_frame·sub_frame. 128·140·149 에서 3개 중 iframe 1개만 | A5-2 |
| C10 | DNR 경로 file:// 는 파일 URL 접근 필요 | 접근 끔: 리다이렉트 없음(128·140·149). 압축해제 확장 기본값은 켬 | A5-3 |
| C11 | 개발자 모드가 꺼진 프로필에서 압축해제 확장 재로드 시 비활성화(140·150) | `disableReasons.unsupportedDeveloperExtension` | 안내 문서 반영(사용자 설치 절차) |

## 8. Action Items

| # | 내용 | 시점 |
|---|---|---|
| A7-1 | 폴백 폰트만 서브셋: (a) 임베딩 전 JS 에서 필요한 글리프만 남긴 TTF 생성(harfbuzz `hb-subset` WASM 등, M3 harfbuzzjs 도입과 함께 검토) 또는 (b) `subsetFonts()` 후 원본 폰트 객체를 저장 전 값으로 되돌림. 검증: arXiv-09268·zen-ko-sim 편집하지 않은 쪽 Poppler·pdf.js 0 px | M1(필수) |
| A7-2 | 텍스트 제거 경로 결정: MuPDF 페이지 redaction(쪽 전체 재직렬화, ActualText 이동) 대신 SourceMap 의 연산자 바이트 범위만 지우는 자체 경로, 또는 redaction 유지 + `ActualText with no position` 경고 시 편집 제한. A1-1(Form 인스턴스화 후처리)과 함께 결정 | M1 설계 |
| A7-3 | `pdf-ops` `xobject.ts` `toRect`·`outsideFormBBox`·`pageBox` 사각형 정규화 + 회귀 테스트(`[0 792 612 0]`) | M1(pdf-ops) |
| A7-4 | Form 인스턴스·문단 배치 영역을 원 텍스트 위치 ∩ BBox ∩ CropBox 로 제한, 벗어나면 L3 판정 | M3 |
| A7-5 | 저장 힙 예측 모델 재산정(A3-5 앞당김 검토): 객체 수·디코드 스트림 크기 항 추가, 100 MB 이상 실제 문서로 warn·over-limit 경계 검증. 코퍼스에 대형 실제 문서 추가 필요 | M1~M5 |
| A7-6 | M2 레이아웃 복원에 stext 줄 병합 포함(본 작업 `mergeLineBlocks` 는 스파이크 수준) | M2 |
| A7-7 | 태그 PDF 기본 동작(편집 문단 31/53 이 MCID 쪽) 결정을 M3 설계 초기에 | M3 |
| A7-8 | 링크 제거 9/53 → A2-1(링크 복원) 우선순위 상향 검토 | M3 |
| A7-9 | 측정 도구: Poppler 단어 비교에서 쪽 표시 영역 밖 단어 제외 | 코퍼스 회귀 테스트 도입 시(M1) |
| A7-10 | 코퍼스 보강: 학술지 한글 CC BY 논문, 공공누리 제1유형 한국 문서, 한국어 수백 쪽 문서, 100 MB 이상 실제 문서, 기존 Redact 주석 문서(0/19), 표 셀 편집용 문서 | M1 코퍼스 회귀 테스트 전 |
| A5-1 | 가로채기 경계를 150 으로 정정(PLAN.md 5.1·6절 DoD·11절). `apps/extension/src/interception.ts` 의 `MIME_HANDLER_MIN_CHROME = 151` 상수·주석 갱신(판정은 API 유무라 동작 영향 없음). 정식 Chrome 150 확인 | M1 |
| A5-2 | DNR 규칙 `resourceTypes` 에 `object` 추가 여부 결정(128–149 의 embed·object 가로채기) | M1 |
| A5-3 | DNR 경로 file:// 는 "파일 URL에 대한 액세스 허용" 필요 → 128–149 안내 UI | M3 |
| A5-4 | Windows 정식 Chrome 128–149 수동 확인은 선택(CfT 결과로 대체 가능 여부 사용자 판단). **2026-10-19 미확인**(W8): 사용자 PC 의 Chrome 이 155 뿐이라 수행 불가, A5 로 남김 | 사용자 |

## 9. 검증

| 명령 | 결과(2026-10-19) |
|---|---|
| `node scripts/corpus/fetch-corpus.mjs --check` | 19/19 OK. 빈 디렉터리 재수신 19/19 일치 |
| `pnpm --filter @pdf-editor/spike-m0 spike:corpus` | 19문서·53문단, 성공 50, 저장 19/19 |
| `pnpm --filter @pdf-editor/spike-m0 spike:pdfjs` | 22쌍 중 20 통과 |
| `… spike:corpus -- --no-subset --out out/m0-corpus-nosubset` + `spike:pdfjs -- --out …` | 대조: Poppler 단어 이동(서브셋 원인분) 0, pdf.js 22/22 |
| `PDF_EDITOR_LEGACY_CHROME=… playwright test dnr-legacy` | 128·140·149·150 4/4 통과 |
| `pnpm exec turbo run build typecheck test test:e2e --force` | 통과. 16/16 작업. Vitest 90건(core 4, extension 21, pdf-ops 33, spike-m0 32 — 이번 작업 +10) + Playwright 1건 통과·1건 건너뜀(`dnr-legacy`, 구버전 Chrome 미지정) |
| `pnpm lint` | 통과 |
| `pnpm format:check`(Prettier, `.prettierignore` 의 md·fixtures 제외) | 통과 |

추가·변경한 코드(커밋 단위는 git log)

| 경로 | 내용 |
|---|---|
| `apps/extension/scripts/fetch-chrome-for-testing.mjs`, `apps/extension/e2e/dnr-legacy.spec.ts` | CfT 내려받기, DNR 실측(기본 실행 시 건너뜀) |
| `tools/spike-m0/src/corpus-select.ts`·`corpus-analyze.ts`·`corpus-edit.ts`·`corpus-cli.ts`·`corpus-xobject.ts`·`pdfjs-check.ts` | 문단 자동 선택, 구조 분석, 편집·검증, 실행기, 공유 Form 경로, pdf.js 확인 |
| `tools/spike-m0/src/raster.ts`·`poppler.ts`·`cli.ts`·`package.json` | 주석 제외 렌더 옵션, Poppler 차이 크기·단어 비교, CLI(`spike:corpus`·`spike:pdfjs`), `pdfjs-dist` 6.4.299 devDependency |
| `tools/spike-m0/test/corpus.test.ts` | 10건(m0 픽스처 기반, 네트워크 불필요) |
| `fixtures/corpus/manifest.json`, `scripts/corpus/fetch-corpus.mjs`, `.gitignore` | 코퍼스 목록·내려받기·PDF 제외 |
| `pnpm-lock.yaml` | `pdfjs-dist` 6.4.299(+ 선택 의존 `@napi-rs/canvas` 1.0.11) |

## PLAN.md 반영 필요

- 0절 상태: "미완" 목록에서 Chrome 128–150 DNR 실측, pdf.js 표시 확인(pdfjs-dist 기준), 실제 코퍼스 재실행을 완료로. 남은 것: Acrobat 확인, 대형 문서 브라우저 측정, 임베디드 문맥 Ctrl+S 재저장, v1 범위·일정 재산정.
- 5.1: "v1 기준: Chrome 151+" → "Chrome 150+(Chrome for Testing 150.0.7871.0 이상 실측, 정식 빌드 미확인)". DNR 구버전 경로 "128–150" → "128–149". DNR 경로 제한 실측 결과 추가: 뷰어가 원 URL 을 다시 받음(GET 2회), POST·`attachment`·embed·object 는 가로채지 않음, file:// 는 파일 URL 접근이 켜져 있어야 동작.
- 6절 M0 DoD 표 "가로채기" 행의 151+/128–150 표기를 같은 기준으로, 판정은 이 문서 5절.
- 11절 Chrome 표: 서버 열에 CfT 128·140·149(DNR)·150(MIME handler) 실측 결과 요약.
- 2절 또는 3.3 FontManager: "저장 시 `subsetFonts()`" → MuPDF `subsetFonts()` 는 문서 전체 폰트를 다시 써서 원본 폰트 `/Widths` 를 바꾼다(C1). 폴백 폰트만 서브셋하는 수단으로 교체(A7-1).
- 3.1 저장 정책 또는 3.4: 페이지 redaction 은 쪽 콘텐츠 전체를 다시 직렬화하며 `ActualText` 가 있는 쪽에서 편집하지 않은 텍스트 위치가 바뀔 수 있다(C2). 텍스트 제거 경로 결정을 M1 설계 항목으로(A7-2).
- 3.4 공유 Form: 실제 코퍼스 결과(9/9 정책 충족, BBox 정규화 필요 C3, BBox ⊄ CropBox C6) 추가, "실제 코퍼스 재실행은 M0 후속(A1-2)" → 완료.
- 5.4·3.1 배율 모델: 실제 문서 저장 증가분 최대 19.1×(C4) 추가, A3-5 시점 재검토.
- 6절 재산정 메모: 6.3 표의 M1(A7-1·A7-2·A7-3·A5-1·A5-2)·M2(A7-6)·M3(A7-4·A7-7·A7-8) 작업량 반영.
- 7절 리스크: C1(subsetFonts 부작용)·C2(redaction 재직렬화) 추가.
- 8절 테스트 계획: 코퍼스는 `fixtures/corpus/manifest.json`(PDF 미커밋, 내려받기 스크립트) 방식, 못 찾은 유형 보강 목록(A7-10).
