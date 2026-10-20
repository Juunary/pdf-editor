/** 벡터 패스 편집(M4, docs/m4-contract.md 4.2·4.3). 현재는 연결용 스텁이다. */
import type {
  PathEdit,
  PathEditPlan,
  PathEditability,
  PathTarget,
  Rect,
} from '@pdf-editor/shared-types';
import type { ParagraphEditContext } from './paragraph-edit.js';

/** 패스 편집이 바꾸는 객체 번호 목록을 담은 준비 결과. */
export interface PreparedPathEdit {
  editId: string;
  target: PathTarget;
  /** 이 편집이 바꾸는 스트림 객체 번호. */
  changedObjects: number[];
}

/** 쪽의 모든 패스 판정(PageModel.paths 순서). */
export function planPathEditability(ctx: ParagraphEditContext): PathEditability[] {
  void ctx;
  throw new Error('M4 미구현: pdf-ops.planPathEditability');
}

/** 선택한 패스의 편집 계획. revision 은 호출자가 채운다. */
export function planPathEdit(
  ctx: ParagraphEditContext,
  paintSeqs: number[],
): Omit<PathEditPlan, 'revision'> {
  void ctx;
  void paintSeqs;
  throw new Error('M4 미구현: pdf-ops.planPathEdit');
}

/** 편집 준비(필요하면 Form 복제 등). 저널 작업 안에서 호출한다. */
export function preparePathEdit(
  ctx: ParagraphEditContext,
  plan: Omit<PathEditPlan, 'revision'>,
  editId: string,
): PreparedPathEdit {
  void ctx;
  void plan;
  void editId;
  throw new Error('M4 미구현: pdf-ops.preparePathEdit');
}

/** 패스 편집을 스트림에 쓴다. 같은 초안에서 반복 호출할 수 있다. */
export function writePathEdit(
  ctx: ParagraphEditContext,
  prepared: PreparedPathEdit,
  edit: PathEdit,
): { bbox: Rect; writeMs: number } {
  void ctx;
  void prepared;
  void edit;
  throw new Error('M4 미구현: pdf-ops.writePathEdit');
}
