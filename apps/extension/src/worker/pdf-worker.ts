// 뷰어 소유 module Worker. MuPDF 와 문서 상태는 여기서만 산다(PLAN.md 5.2).
import { exposePdfWorker } from '@pdf-editor/core/worker';

exposePdfWorker(self as unknown as Parameters<typeof exposePdfWorker>[0]);
