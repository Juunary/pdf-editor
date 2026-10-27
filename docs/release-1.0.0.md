# 릴리스 기록: 1.0.0

절차: [release.md](release.md). 사용자 결정(2026-10-27): 저장소 공개 전환, 미충족 DoD 를 알려진 제한으로 두고 이 상태로 1.0.0 을 냅니다.

## 1. 버전·커밋

| 항목 | 값 |
| --- | --- |
| 버전 | 1.0.0(`apps/extension/package.json`) |
| 태그 | `v1.0.0`(`main`, `m5-windows` 병합 뒤) |
| 검증 일자 | 2026-10-27(서버) |

## 2. 검증

| 명령 | 결과 |
| --- | --- |
| `pnpm exec turbo run build typecheck test test:e2e --force` | 25/25 작업 성공, 캐시 0 |
| 단위 시험 | shared-types 4, layout-recon 60(+3 건너뜀), reflow 60, pdf-ops 457(+5), core 308(+7), viewer-ui 331, extension 119, spike-m0 33(+1). 합계 1,372 통과, 16 건너뜀 |
| e2e | 191 통과, 6 건너뜀(옵트인) |
| `pnpm lint` | 오류 0 |
| `pnpm exec prettier --check .` | 통과 |
| `pnpm --filter @pdf-editor/extension package` | 성공(`verify-dist --release` 포함) |

간헐 실패: 같은 브랜치 직전 연속 실행에서 편집 Worker 복구 e2e 1건이 1회 실패(`#pe-edit-hover` 대기 시간 초과), 단독 15회·전체 191건 2회 통과. 원인 미확인.

## 3. 패키지

| 파일 | 크기 | sha256 |
| --- | --- | --- |
| `pdf-editor-1.0.0.zip` | 7,170,424 B | `8ee34717f9a7643cd8e5691c857a0864bd8d5e49a62a96b2c74773418f180bd0` |
| `pdf-editor-1.0.0-sourcemaps.zip` | 658,714 B | `5fe6a42ba205ccf78bf32998e60481cf980f20ed75da26033c3deb7d4a316604` |

- 스테이징 압축 전 15,737,321 B. 번들 패키지 comlink 4.4.2, harfbuzzjs 1.6.2, mupdf 1.28.1, preact 10.29.8.
- Web Store 빌드: Chrome 151 이상, 권한 `downloads` 만.

## 4. 벤치마크 요약

Windows 기준 PC(2026-10-22 회신, `docs/m5-integration.md` 9.2): 열기 p95 46–1,055 ms, 쪽 넘김 p95 45–287 ms, 저장 p95 66–494 ms(7문서).

## 5. 알려진 제한(미충족 DoD)

| 항목 | 상태 | 근거 |
| --- | --- | --- |
| 편집 반응 | nasa-se-handbook 중앙값 118 ms(목표 100 ms), p95 기준 초과 4건 | `docs/m5-integration.md` 9.2 W1 |
| 탭 메모리 | 큰 쪽 장시간 편집 뒤 증가 573 MiB(서버, 목표 150 MiB) | `docs/m5-followup.md` 5.2 |
| WASM 메모리 | W2 수정 뒤 서버 24.3 MiB, Windows 재측정 안 함 | `docs/m5-followup.md` 5.1 |
| 100 MB 이상 실제 문서 | 확인 안 함 | `docs/m5-integration.md` 9.2 |
| 성능 합격 기준(중앙값·p95) | 미정 | 같은 문서 |
