export type BuildKind = 'dev' | 'store';
export const REPO_URL: string;
export function sourceUrl(version: string): string;
export const BUILD_KINDS: readonly BuildKind[];
export const STORE_MIN_CHROME: string;
export const DEV_NAME_SUFFIX: string;
export function buildManifest(
  base: Record<string, unknown>,
  kind: BuildKind,
  version: string,
): Record<string, unknown>;
export const STORE_NAME: string;
export const DEFAULT_LOCALE: string;
export const LOCALES: readonly string[];
export const MAX_DESCRIPTION_CHARS: number;
export const NAME_MESSAGE: string;
export interface LocaleMessage {
  message: string;
  description?: string;
}
export type LocaleMessages = Record<string, LocaleMessage>;
export function messageKey(value: unknown): string | null;
export function resolveMessage(value: unknown, messages: LocaleMessages): string | null;
export function readLocales(dir: string): Record<string, LocaleMessages>;
export function buildLocaleMessages(
  locales: Record<string, LocaleMessages>,
  kind: BuildKind,
): Record<string, LocaleMessages>;
