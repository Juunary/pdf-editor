# pdf-editor

PDF 문단 리플로우·표 셀·벡터 패스 편집기. Chrome 확장(MV3), 코어는 TypeScript + MuPDF WebAssembly(npm `mupdf`). 라이선스: AGPL-3.0-or-later.

기능: PDF 열기, 텍스트 선택·복사, 문서 검색, 문단 편집(리플로우, 한글 입력), 표 셀 텍스트 편집, 벡터 패스 편집(이동·크기·점·색·선 두께·삭제), 되돌리기·다시 실행, 편집 가능 표시, 저장.

## 실행

```bash
corepack enable pnpm   # pnpm 11.28.6 (package.json packageManager), Node 22.13 이상
pnpm install
pnpm build             # apps/extension/dist 생성
pnpm test              # Vitest + Playwright(번들 Chromium)
pnpm lint
pnpm exec prettier --check .
```

최초 e2e 실행 전: `pnpm --filter @pdf-editor/extension exec playwright install chromium`.

Chrome 에 올리기: `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드합니다" → `apps/extension/dist`. 자세한 설치·사용은 [docs/user](docs/user/README.md).

## 구조

| 경로 | 내용 |
| --- | --- |
| `packages/shared-types` | 공통 타입, Worker RPC 계약 |
| `packages/core` | MuPDF 수명·문서 상태, 렌더, 편집 엔진, Worker RPC(Comlink) |
| `packages/pdf-ops` | 콘텐츠 스트림 인터프리터(SourceMap), 텍스트·패스 편집 쓰기, 폰트 임베딩, 저장 방식 결정 |
| `packages/layout-recon` | 쪽 모델 → 문단·열·표·도형·읽기 순서 |
| `packages/reflow` | 셰이핑·줄 배치 |
| `packages/viewer-ui` | Preact 뷰어: 선택 층, 검색, 편집기, 패스 편집, 편집 가능 표시 |
| `apps/extension` | MV3 셸: manifest, 서비스 워커, 뷰어, Worker, 저장 어댑터 |
| `assets/fonts` | 폴백 폰트(Noto Sans KR 서브셋 TTF, OFL-1.1) |
| `fixtures` | 코퍼스 매니페스트, 정확도 라벨, 벤치 매니페스트 |
| `docs` | 사용자 문서(`docs/user`), 등록 자료(`docs/store`), 계약·작업 기록 |

구조와 데이터 흐름: [docs/architecture.md](docs/architecture.md).

## 결과

| 항목 | 값 | 출처 |
| --- | --- | --- |
| 코퍼스 편집 330건(문단), 편집 영역 밖 렌더 변화 0 px | MuPDF·pdf.js·Poppler 각 330/330 | `docs/m4-integration.md` 4.1 |
| 표 셀 편집 63건, 영역 밖 렌더 0 px | 세 엔진 각 63/63 | 같은 문서 4.2 |
| 패스 편집 60건, 영역 밖 렌더 0 px | 세 엔진 각 60/60 | 같은 문서 4.2 |
| 재적용 결정성(새 세션 재적용 = 원래) | 셀 63/63, 패스 60/60 | 같은 문서 4.2 |
| 레이아웃 복원(test2, 라벨 14쪽) | 문단 F1 0.881, 표 P/R 1.0 | `docs/m2-accuracy.md` |
| 패스 끌기 갱신(코퍼스 최대 패스 쪽, 서버) | p95 89.3 ms(배율 2) | `docs/m4-integration.md` 4.3 |
| 단위 시험 | pdf-ops 443, core 278, viewer-ui 285, reflow 60, layout-recon 60, extension 46 | 같은 문서 8.2 |
| e2e | 119 통과 | 같은 문서 8.2 |

모든 수치는 서버(Linux, Node 22, Playwright 번들 Chromium) 측정입니다. Windows 기준 PC 성능 측정은 M5 에서 진행합니다(`docs/m5-contract.md` D1).

## 한계

- 한 쪽씩 보기(연속 스크롤 없음).
- 편집 제한 사유가 있는 문단·셀·패스는 편집할 수 없습니다: 세로쓰기·Type3·클립 텍스트·OCR 층·패턴 채움 등. 목록: [docs/user/limits.md](docs/user/limits.md).
- 행·열 추가, 병합·분할, 새 패스 그리기, 이미지 내용 편집, 폼·서명, OCR 은 지원하지 않습니다.
- 편집한 문서는 전체 저장입니다. WASM 힙 상한(2 GiB) 때문에 큰 문서는 저장 전에 경고하거나 중단합니다.
- Web Store 빌드는 Chrome 151 이상. Chrome 128–150 은 개발·레거시 빌드의 제한된 경로입니다.
