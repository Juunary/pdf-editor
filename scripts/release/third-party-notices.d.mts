export interface BundlePackage {
  name: string;
  version: string;
  dir: string;
  license: string;
  homepage: string | null;
  author: string | null;
}
export const EXTRA_JSON: string;
export function collectBundlePackages(
  mapFiles: string[],
  nodeModulesRoot?: string,
): BundlePackage[];
export function readLicenseTexts(dir: string): { file: string; text: string }[];
export function loadExtra(): {
  mupdfWasm: { package: string; version: string; buildConfig: string };
  entries: {
    name: string;
    version: string;
    license: string;
    homepage: string;
    copyright?: string;
    notice?: string;
    licenseFiles: string[];
    evidence: string;
  }[];
};
export function renderNotices(input: {
  version: string;
  sourceUrl: string;
  packages: BundlePackage[];
  extra?: ReturnType<typeof loadExtra>;
}): string;
