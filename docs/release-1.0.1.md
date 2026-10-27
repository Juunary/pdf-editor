# 릴리스 기록: 1.0.1

절차: [release.md](release.md). 1.0.0 대비 변경: 확장 아이콘(문서 위 연필, 접힌 모서리 수정), 스토어 스크린샷 자동 촬영 스펙(opt-in), 코드 주석·시험 제목 영어화(PR #11). 동작 변경은 없습니다.

## 1. 버전·커밋

| 항목 | 값 |
| --- | --- |
| 버전 | 1.0.1(`apps/extension/package.json`) |
| 태그 | `v1.0.1`(`main` 병합 뒤, 사용자 승인 단계) |
| 검증 일자 | 2026-10-27(서버) |

## 2. 검증

| 명령 | 결과 |
| --- | --- |
| `pnpm exec turbo run build typecheck test test:e2e --force` | 25/25 작업 성공, 캐시 0 |
| 단위 시험 | shared-types 4, layout-recon 60(+3 건너뜀), reflow 60, pdf-ops 457(+5), core 308(+7), viewer-ui 331, extension 119, spike-m0 34. 합계 1,373 통과, 15 건너뜀 |
| e2e | 191 통과, 20 건너뜀(옵트인, 스토어 스크린샷 14건 포함) |
| `pnpm lint` | 오류 0 |
| `pnpm exec prettier --check .` | 통과 |
| `pnpm --filter @pdf-editor/extension package` | 성공(`verify-dist --release` 포함) |

## 3. 패키지

| 파일 | 크기 | sha256 |
| --- | --- | --- |
| `pdf-editor-1.0.1.zip` | 7,172,179 B | `d3aced2626a28c93f6706e5a8af16de14f55a67df3077b5b95b7535155a4a209` |
| `pdf-editor-1.0.1-sourcemaps.zip` | 655,807 B | `5bcbc6c03c71e2b559fc121cfc812dc045c22d0f64f5674e98259cd359c2f0bb` |

- 스테이징 압축 전 15,738,960 B(24개 파일). 매니페스트 버전 1.0.1, Chrome 151 이상, 권한 `downloads` 만.
- zip 안 `icons/icon-{16,32,48,128}.png` 가 `apps/extension/public/icons/` 와 같음을 확인했습니다.

## 4. 벤치마크·알려진 제한

동작 변경이 없어 다시 측정하지 않았습니다. [release-1.0.0.md](release-1.0.0.md) 4–5절이 그대로 적용됩니다.
