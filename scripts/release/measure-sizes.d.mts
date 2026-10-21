export function measureAssets(
  dir: string,
): { file: string; kind: string; raw: number; gzip: number; brotli: number }[];
