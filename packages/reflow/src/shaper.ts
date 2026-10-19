/**
 * 셰이퍼 인터페이스(계약 D5). 한 폰트로 쓰는 연속 클러스터를 받아 클러스터마다 글리프와 전진량을 돌려준다.
 * 단위는 1/1000 em(글자 크기 곱하기 전).
 */
import type { EncodedGlyph, FontFace } from './index.js';
import { shapeOpenType } from './opentype.js';

export interface ShapedGlyph {
  gid: number;
  /** 쓰기용 코드 바이트. 원본 폰트는 폰트 인코딩·CMap 코드, 폴백 폰트는 2바이트 gid(Identity-H). */
  code: Uint8Array;
  /** 배치 전진량(커닝 포함). */
  advance: number;
  /** 글리프 원점의 가로 오프셋(GPOS). */
  xOffset: number;
  /** PDF 명세 폭(/Widths·/W). 쓰기가 advance 와의 차이를 TJ 숫자로 보정한다. */
  pdfWidth: number;
}

export interface ShapedCluster {
  /** 1개 이상. */
  glyphs: ShapedGlyph[];
  /** 클러스터 전진량 합(커닝 포함). */
  advance: number;
  /** advance 중 다음 클러스터와의 커닝 몫. 줄 끝 클러스터면 뺀다. */
  kernAfter: number;
}

/** 쓸 수 없는 클러스터는 null(폰트에 글리프가 없음, glyph-missing 과 같이 배치하지 않는다). */
export type ShapeResult = (ShapedCluster | null)[];

/** text 의 연속 클러스터 [시작, 끝) 목록을 셰이핑한다. 같은 폰트·같은 줄바꿈 구간 안이다. */
export interface Shaper {
  shape(text: string, clusters: readonly (readonly [number, number])[]): ShapeResult;
}

/** 폰트 원천에 맞는 셰이퍼. */
export function shaperFor(face: FontFace): Shaper {
  const source = face.source;
  if (source.kind === 'pdf-widths') return pdfWidthsShaper(source.encode);
  return {
    shape: (text, clusters) =>
      shapeOpenType(face.key, source.bytes, source.pdfWidth, text, clusters),
  };
}

/** 원본 폰트: encode 결과의 PDF 명세 폭으로 놓고 커닝하지 않는다(계약 D5). */
function pdfWidthsShaper(encode: (cluster: string) => EncodedGlyph[] | null): Shaper {
  return {
    shape(text, clusters) {
      return clusters.map(([s, e]) => {
        const encoded = encode(text.slice(s, e));
        if (encoded === null || encoded.length === 0) return null;
        let advance = 0;
        const glyphs = encoded.map((g) => {
          advance += g.width;
          return { gid: g.gid, code: g.code, advance: g.width, xOffset: 0, pdfWidth: g.width };
        });
        return { glyphs, advance, kernAfter: 0 };
      });
    },
  };
}
