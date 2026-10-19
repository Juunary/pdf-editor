/**
 * 복원 상수(docs/m2-contract.md 3절). 정확도 하네스 dev 세트로만 조정한다.
 * 길이는 pt, *Em 은 줄 글자 크기 배수, *Ratio 는 비율.
 */
export const C = {
  /** 이 두께 이하 채움 사각형은 괘선으로 본다. */
  thinBoxMax: 2,
  /** 머리·꼬리 띠: 쪽 높이 대비. */
  marginBand: 0.09,
  /** 머리·꼬리와 본문 사이 최소 간격(본문 글자 크기 배수). */
  marginGapEm: 1.2,
  /** 같은 행 줄 조각을 합치는 최대 간격(글자 크기 배수). */
  rowJoinGapEm: 1.0,
  /** 같은 행 판정: 세로 겹침이 낮은 쪽 높이의 이 비율 이상. */
  sameRowOverlap: 0.5,
  /** 영역 쌓기: x 겹침이 좁은 쪽 폭의 이 비율 이상. */
  stackOverlap: 0.5,
  /** 영역 쌓기: 세로 간격 상한(글자 크기 배수). */
  stackGapEm: 2.5,
  /** 문단 나누기: 줄 간격이 영역 기준 간격의 이 배수 초과. */
  paraPitchRatio: 1.15,
  /** 들여쓰기 판정(글자 크기 배수). */
  indentEm: 0.5,
  /** 짧은 줄: 영역 오른쪽 기준선보다 이 비율(영역 폭 대비)만큼 일찍 끝남. */
  shortLineRatio: 0.12,
  /** 제목: 본문 크기 대비. */
  headingSizeRatio: 1.15,
  /** 글자 크기 변화로 문단을 나누는 비율. */
  sizeChangeRatio: 0.12,
  /** XY-cut 세로 빈 띠 최소 폭. */
  gutterMin: 4,
  /** 도형: 이미지 최소 면적(쪽 면적 대비). */
  imageMinArea: 0.005,
  /** 도형: 벡터 군집 최소 면적(쪽 면적 대비). */
  vectorMinArea: 0.01,
  /** 도형: 벡터 군집 이음 거리. */
  vectorJoin: 8,
  /** 도형: 이미지가 이 비율 이상의 글자를 덮으면 배경·스캔으로 본다. */
  backgroundCharRatio: 0.5,
} as const;
