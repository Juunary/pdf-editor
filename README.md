# pdf-editor

PDF 문단 리플로우·표·벡터 도표 편집기. Chrome 확장(MV3) 우선, 코어는 TypeScript + MuPDF WebAssembly(npm `mupdf`). 계획: `PLAN.md`. 라이선스: AGPL-3.0-or-later.

## 실행

```bash
corepack enable pnpm   # pnpm 11.28.6 (package.json packageManager)
pnpm install
pnpm build             # apps/extension/dist 생성(압축해제된 확장 프로그램으로 로드)
pnpm test              # Vitest + Playwright(번들 Chromium, 최초 1회 `pnpm --filter @pdf-editor/extension exec playwright install chromium`)
pnpm spike             # M0 스파이크 → out/m0-day1/spike-result.json
```

## 구조

| 경로 | 내용 |
|---|---|
| `packages/shared-types` | 공통 타입, Worker RPC 계약 |
| `packages/core` | MuPDF 수명·문서 상태, 렌더, Worker RPC(Comlink) |
| `packages/pdf-ops` | redaction 래퍼, 폰트 임베딩, 콘텐츠 스트림 추가·직렬화, 저장 방식 결정 |
| `apps/extension` | MV3 셸: manifest, 서비스 워커(DNR 폴백), 뷰어, 뷰어 소유 Worker, 저장 어댑터 |
| `tools/spike-m0` | M0 기술 검증 스파이크(M0 종료 후 정리) |
| `assets/fonts` | 폴백 폰트(Noto Sans KR 서브셋 TTF, OFL-1.1) |
| `fixtures/m0` | M0 샘플·스파이크 출력 |
| `docs/` | 작업 기록 |

## 결과·한계

M0 Day 1 결과와 Windows 확인 항목: `docs/m0-day1-log.md`.
M0 DoD 잔여 항목(공유 Form XObject·기존 Redact 주석·대형 문서 저장 상한): `docs/m0-dod-xobject-redact-save.md`.
