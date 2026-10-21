# 릴리스 절차

기준: `docs/m5-contract.md` D2·D6·D7. 명령 이름과 산출물 경로는 S3 구현(`docs/m5-release.md`)과 대조해 확정합니다. 원격 저장소에 올리는 단계(푸시·태그 푸시·Web Store 제출)는 모두 사용자 승인 단계입니다.

## 1. 버전

- 버전의 출처는 하나입니다: `apps/extension/package.json` 의 `version`. 빌드가 이 값을 매니페스트에 넣습니다.
- 형식은 `MAJOR.MINOR.PATCH`(첫 공개 1.0.0). Web Store 는 업로드마다 버전이 커져야 합니다.
- 버전을 올리는 커밋은 다른 변경과 분리합니다.

## 2. 사전 검증

| 단계 | 명령 | 통과 기준 |
| --- | --- | --- |
| 전체 검증 | `pnpm exec turbo run build typecheck test test:e2e --force` | 종료 코드 0 |
| 정적 검사 | `pnpm lint`, `pnpm exec prettier --check .` | 통과 |
| 코퍼스 회귀 | M3·M4 코퍼스 하네스(`docs/m3-integration.md`, `docs/m4-integration.md`) | 직전 기록 대비 회귀 없음 |
| 벤치마크 | S2 하네스(서버), Windows 기준 PC 수동 실행 | 목표 충족, 서버는 직전 기록 +20% 초과 지표 표시(`docs/m5-contract.md` D1) |

## 3. 패키지 생성

```bash
pnpm --filter @pdf-editor/extension package
```

- `dist` 에서 `diag/`·`*.map` 을 뺀 `out/release/staging/` 을 만들고, 그 내용으로 zip 을 `out/release/` 에 만듭니다. 같은 입력이면 같은 바이트가 나옵니다.
- 소스맵은 `hidden` 이고 zip 에 넣지 않으며, 릴리스 자산으로 따로 보관합니다.
- Web Store 빌드는 Chrome 151 이상 구성(DNR·호스트 권한·`<all_urls>` 접근 가능 리소스 없음)입니다. 개발·레거시 빌드(Chrome 128–150 DNR 경로)는 Web Store 에 올리지 않습니다.

## 4. 패키지 검증

`verify-dist --release out/release` 로 스테이징과 zip 을 검사합니다.

| 검사 | 기준 |
| --- | --- |
| 개발 파일 | `diag/`·`*.map`·`sourceMappingURL` 없음 |
| 크기 | 압축 전 합계 25 MiB 이하, zip 15 MiB 이하(자체 기준) |
| 버전 | 매니페스트 = `apps/extension/package.json` |
| 필수 파일 | 아이콘 16·32·48·128, `LICENSE`, `THIRD_PARTY_NOTICES.txt`, 저작권 고지 |
| 권한 | `manifest.json` 이 `docs/store/practices.md` 의 권한 표와 일치 |

스테이징 스모크 e2e: 스테이징을 압축해제 확장으로 로드하고 http 로 제공한 픽스처로 열기·렌더·저장을 확인합니다.

## 5. 수동 확인(사용자)

- Windows Chrome 에 스테이징을 압축해제로 로드해 설치 안내([user/install.md](user/install.md))대로 설치하고 M4 기능을 확인합니다.
- 진단의 `interceptionMode` 가 `mimeHandler`(`mime-handler`)인지 확인합니다.
- Web Store 개발자 대시보드에 zip 초안을 업로드해 오류가 없는지 확인합니다(선택).

## 6. 태그·릴리스

1. 사용자 승인을 받습니다.
2. 버전 커밋을 `main` 에 병합한 뒤 주석 태그를 만듭니다(로컬).

   ```bash
   git tag -a v<version> -m "v<version>"
   ```

3. **태그 푸시는 사용자 승인 단계입니다.** 승인 전에는 푸시하지 않습니다.

   ```bash
   git push origin v<version>
   ```

4. 태그를 기준으로 GitHub 릴리스를 만들고 zip, 소스맵, `THIRD_PARTY_NOTICES.txt` 를 자산으로 붙입니다.
5. 뷰어의 "정보" 대화상자 AGPL 소스 링크가 `/tree/v<version>` 을 가리키므로, 태그가 존재해야 링크가 유효합니다. Web Store 제출 전에 태그를 푸시합니다.

## 7. Web Store 제출(사용자)

개발자 계정 등록·결제·제출·심사 대응은 사용자가 합니다. 자료: [store/README.md](store/README.md).

| 단계 | 내용 |
| --- | --- |
| 업로드 | `out/release/` 의 zip |
| 등록 정보 | [store/listing.md](store/listing.md) |
| 개인정보 관행 | [store/practices.md](store/practices.md) |
| 개인정보 처리 방침 URL | [store/privacy-policy.md](store/privacy-policy.md) 의 저장소 공개 링크 |
| 이미지 | [store/assets.md](store/assets.md) |
| 공개 범위 | 사용자 결정(권고: 비공개 테스트 → 공개) |

## 8. 릴리스 기록

릴리스마다 버전, 커밋, 검증 결과(명령·통과 여부), 벤치마크 요약, 패키지 크기를 `docs/` 에 기록합니다.
