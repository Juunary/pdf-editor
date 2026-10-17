// M0 Day 1 1단계: MuPDF 를 Worker 번들에 포함시키는 최소 엔트리. 2단계에서 RPC 로 교체한다.
import { openPdf } from '@pdf-editor/core';

self.postMessage({ ready: typeof openPdf === 'function' });
