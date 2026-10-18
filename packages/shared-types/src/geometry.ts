/**
 * 기하 기본 타입.
 *
 * 좌표계 두 가지를 구분한다(docs/m1-contract.md 2절).
 * - 페이지 공간: MuPDF 페이지 좌표. 페이지 경계 기준 원점 좌상단, y 아래 방향, 단위 pt.
 *   `/Rotate`·박스 오프셋이 이미 반영된 값이다. `Page.getBounds()`, 구조화 텍스트,
 *   항등 행렬로 실행한 Device 콜백이 이 공간의 값을 준다. PageModel 의 모든 기하는 이 공간이다.
 * - 사용자 공간: PDF 기본 사용자 공간. 원점 좌하단, y 위 방향. 콘텐츠 스트림의 CTM·텍스트 행렬은
 *   이 공간으로 보낸다. 사용자 공간 → 페이지 공간 변환은 `PDFPage.getTransform()` 이다.
 */

/** 사각형 [x0, y0, x1, y1]. 공간은 필드 설명을 따른다(기본: 페이지 공간). 단위 pt. */
export type Rect = [number, number, number, number];

/** 점 [x, y]. */
export type Point = [number, number];

/** 사각형 네 꼭짓점 [ulx, uly, urx, ury, llx, lly, lrx, lry]. MuPDF Quad 순서(ul, ur, ll, lr). */
export type Quad = [number, number, number, number, number, number, number, number];

/** 아핀 행렬 [a, b, c, d, e, f]. 점 (x, y) → (a·x + c·y + e, b·x + d·y + f). */
export type Matrix = [number, number, number, number, number, number];

/** sRGB 0–1. */
export type RGB = [number, number, number];

/** 바이트 범위 [start, end). 디코드한 스트림 바이트 기준. */
export type ByteRange = [number, number];
