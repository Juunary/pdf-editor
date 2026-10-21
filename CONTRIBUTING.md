# 기여 안내

## 준비

```bash
corepack enable pnpm   # pnpm 11.28.6, Node 22.13 이상
pnpm install --frozen-lockfile
pnpm build
```

e2e 에는 Playwright Chromium 이 필요합니다: `pnpm --filter @pdf-editor/extension exec playwright install chromium`.

## 검증

변경을 제출하기 전에 아래를 통과시킵니다.

| 명령 | 내용 |
| --- | --- |
| `pnpm exec turbo run build typecheck test test:e2e --force` | 빌드·타입·단위·e2e 전체(캐시 없이) |
| `pnpm lint` | ESLint |
| `pnpm exec prettier --check .` | 서식(`pnpm format` 으로 수정) |

일부만 돌릴 때: `pnpm --filter @pdf-editor/<패키지> test`. 서버(Linux)에서 하는 e2e 는 Playwright 번들 Chromium 으로 확장을 로드합니다. Windows Chrome 확인은 별도 수동 절차이며 기록을 구분합니다.

## 코드 규칙

- TypeScript, ESM. 주변 코드의 이름·주석 밀도·관용구를 따릅니다.
- `packages/shared-types` 변경(공통 타입·RPC 계약)은 먼저 합의하고 단독 커밋으로 올립니다. 병렬 작업은 이 커밋에서 시작합니다.
- PDF 엔진(MuPDF) 객체는 쓰고 나면 `destroy()` 합니다. 압축 필터가 있는 이미지 XObject 를 `resolve()` 하지 않습니다(`PLAN.md` 7절 리스크 7).
- 편집 쓰기는 원본 바이트 보존을 우선합니다. 편집 영역 밖 렌더·다른 쪽·객체 불변을 시험으로 확인합니다(`docs/m3-contract.md` 검증 축).
- 새 의존성은 정확한 버전을 고정하고 `pnpm-lock.yaml` 을 함께 갱신합니다.

## 코퍼스와 픽스처

- 시험용 PDF 파일은 커밋하지 않습니다(`.gitignore`·`.prettierignore` 의 `*.pdf`). `fixtures/corpus/manifest.json` 에 URL·라이선스 근거·SHA-256 을 적고 `scripts/corpus/fetch-corpus.mjs` 로 받습니다.
- 코퍼스에 넣는 문서는 공공영역(미국 연방 정부 저작물), 공공누리 제1유형, CC BY 중 하나여야 하고 근거 문구를 기록합니다.
- 정확도 정답 라벨(`fixtures/labels`)은 원본을 확인한 독립 검토를 거칩니다(`docs/m2-labeling-guide.md`).

## 커밋

- 단계별로 나누어 커밋하고, 메시지는 변경 내용을 한 줄로 요약합니다.
- 작업이 끝나기 전에 원격 저장소로 푸시하지 않습니다.

## 문서

- README 는 개요·실행·구조·결과 표·한계만 둡니다. 측정값은 출처 문서를 적습니다.
- 계약·작업 기록은 `docs/` 에 두고 [docs/architecture.md](docs/architecture.md) 색인에 추가합니다.

## 라이선스

AGPL-3.0-or-later. 기여한 코드는 같은 조건으로 공개됩니다. 번들되는 제3자 구성요소의 고지는 릴리스 때 `THIRD_PARTY_NOTICES.txt` 로 만듭니다([docs/release.md](docs/release.md)).

## 보안·문의

취약점은 공개 이슈 대신 저장소 관리자에게 비공개로 알립니다. 일반 문의는 https://github.com/Juunary/pdf-editor/issues.
