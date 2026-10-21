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
