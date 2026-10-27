/** Content of the "정보" (About) dialog (pure): version, license, source link, supported scope, and undo history notice. */
import { SUPPORTED_INPUT_BYTES } from '@pdf-editor/core/client';
import type { SaveHeapEstimate } from '@pdf-editor/shared-types';
import type { DialogLink } from './dialog.js';
import { APP_STRINGS, type AppStrings } from './strings.js';

export interface AboutInput {
  version: string;
  /** AGPL source link (`/tree/v<version>`). */
  sourceUrl: string;
  /** In-extension URL of THIRD_PARTY_NOTICES.txt. null in dev builds, which have no such file. */
  noticesUrl: string | null;
  /** Heap from the current document's latest pre-save check (none if there is no document or no check yet). */
  heap: SaveHeapEstimate | null;
  /** Upper limit of supported document size (bytes). Defaults to core `SUPPORTED_INPUT_BYTES`. */
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
