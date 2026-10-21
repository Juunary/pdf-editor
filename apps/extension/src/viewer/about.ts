/** "정보" 대화상자 내용(순수): 버전·라이선스·소스 링크·지원 범위·되돌리기 기록 안내. */
import type { SaveHeapEstimate } from '@pdf-editor/shared-types';
import type { DialogLink } from './dialog.js';

export interface AboutInput {
  version: string;
  /** AGPL 소스 링크(`/tree/v<version>`). */
  sourceUrl: string;
  /** THIRD_PARTY_NOTICES.txt 의 확장 내부 URL. 개발 빌드에는 파일이 없어 null. */
  noticesUrl: string | null;
  /** 지금 문서의 최근 저장 전 판정 힙(없으면 문서 없음·판정 전). */
  heap: SaveHeapEstimate | null;
}

export interface AboutContent {
  title: string;
  lines: string[];
  links: DialogLink[];
}

const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(0)} MiB`;

export function aboutContent(input: AboutInput): AboutContent {
  const lines = [
    `버전 ${input.version}`,
    '라이선스: GNU Affero General Public License v3.0 이상(AGPL-3.0-or-later). 이 프로그램은 보증 없이 제공됩니다. 소스 코드는 아래 링크에서 받을 수 있습니다.',
    '지원 문서 크기: 저장할 때 필요한 메모리를 미리 계산해, 한계에 가까우면 경고하고 한계를 넘으면 저장하지 않고 안내합니다. 매우 큰 문서(수백 MB, 수천 쪽)는 열람만 되고 편집·저장이 실패할 수 있습니다.',
    '편집 기록: 편집한 내용은 메모리에 기록(저널)으로 쌓입니다. 편집이 많아 메모리가 부족해지면 먼저 저장한 뒤 파일을 다시 여세요(다시 연 뒤에는 이전 편집을 되돌릴 수 없습니다).',
    '되돌리기·다시 실행: 작업 모듈이 중단되어 복구되면 되돌리기 기록이 사라집니다. 되돌린 뒤 새 편집을 시작하면 다시 실행 기록이 사라집니다. 폴백 글꼴을 쓴 편집을 되돌린 직후 저장해도 다시 실행 기록이 사라집니다.',
  ];
  if (input.heap) {
    lines.push(
      `이 문서의 저장 예상 메모리: ${mib(input.heap.estimatedPeakBytes)} / 한계 ${mib(input.heap.limitBytes)}`,
    );
  }
  const links: DialogLink[] = [{ label: `소스 코드 (v${input.version})`, href: input.sourceUrl }];
  if (input.noticesUrl) links.push({ label: '서드파티 라이선스 고지', href: input.noticesUrl });
  return { title: 'PDF Editor 정보', lines, links };
}
