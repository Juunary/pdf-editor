/** "정보" 대화상자 내용(순수): 버전·라이선스·소스 링크·지원 범위·되돌리기 기록 안내. */
import { SUPPORTED_INPUT_BYTES } from '@pdf-editor/core/client';
import type { SaveHeapEstimate } from '@pdf-editor/shared-types';
import type { DialogLink } from './dialog.js';
import { APP_STRINGS, type AppStrings } from './strings.js';

export interface AboutInput {
  version: string;
  /** AGPL 소스 링크(`/tree/v<version>`). */
  sourceUrl: string;
  /** THIRD_PARTY_NOTICES.txt 의 확장 내부 URL. 개발 빌드에는 파일이 없어 null. */
  noticesUrl: string | null;
  /** 지금 문서의 최근 저장 전 판정 힙(없으면 문서 없음·판정 전). */
  heap: SaveHeapEstimate | null;
  /** 지원 문서 크기 상한(byte). 기본은 core `SUPPORTED_INPUT_BYTES`. */
  supportedBytes?: number;
}

export interface AboutContent {
  title: string;
  lines: string[];
  links: DialogLink[];
}

const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(0)} MiB`;

export function aboutContent(input: AboutInput, t: AppStrings = APP_STRINGS.ko): AboutContent {
  const lines = [
    t.aboutVersion(input.version),
    t.aboutLicense,
    t.aboutSupportedSize(mib(input.supportedBytes ?? SUPPORTED_INPUT_BYTES)),
    t.aboutJournal,
    t.aboutUndo,
  ];
  if (input.heap) {
    lines.push(t.aboutHeapNow(mib(input.heap.estimatedPeakBytes), mib(input.heap.limitBytes)));
  }
  const links: DialogLink[] = [{ label: t.aboutSourceLink(input.version), href: input.sourceUrl }];
  if (input.noticesUrl) links.push({ label: t.aboutNoticesLink, href: input.noticesUrl });
  return { title: t.aboutDialogTitle, lines, links };
}
