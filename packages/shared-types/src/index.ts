/**
 * 패키지 간 공통 타입과 Worker RPC 계약.
 *
 * M1 계약(docs/m1-contract.md): 추출 모델·원본 연결 정보·매칭 결과·검색·저장 판정·RPC.
 * 병렬 구현은 이 계약을 고정한 커밋에서 시작하고, 변경은 메인 세션만 한다(PLAN.md 10절).
 * M2 계약(docs/m2-contract.md): 쪽 레이아웃(PageLayout·DocumentModel). EditOp·EditPlan 은 M3 시작 시 추가한다.
 */
export * from './geometry.js';
export * from './page-model.js';
export * from './source-map.js';
export * from './search.js';
export * from './save.js';
export * from './page-layout.js';
export * from './rpc.js';
