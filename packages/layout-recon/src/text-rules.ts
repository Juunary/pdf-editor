/** 텍스트 패턴(글머리·캡션·쪽 번호·문장 끝). */

/** 글머리·번호 목록 시작. */
export const BULLET =
  /^\s*(?:\[\d{1,3}\](?=\s)|[•◦▪▫●○■□►▶‣⁃∙·–—*»›➢➤✓✔❖◆◇-]|[①-⑳]|\(\d{1,2}\)|\d{1,2}[.)](?=\s)|[a-z][.)](?=\s)|[A-Z]\)(?=\s)|[가-하][.)](?=\s)|\([a-zA-Z가-하]\)|[ivxIVX]{1,4}[.)](?=\s))/u;

/** 번호 제목("1.", "2.3", "제 1 장", "IV."). */
export const NUMBERED_HEADING = /^\s*(?:\d+(?:\.\d+)*\.?|[IVX]{1,5}\.|제\s*\d+\s*[장절편])\s+\S/u;

export const CAPTION =
  /^\s*(?:Figure|Fig\.|Table|Exhibit|Chart|Box|Plate|그림|표|도표|사진|<\s*(?:표|그림)|\[\s*(?:표|그림))\s*[A-Z]?\d/iu;

/** 쪽 번호 형식. */
export const PAGE_NUMBER =
  /^\s*(?:[-–—]\s*\d{1,4}\s*[-–—]|\d{1,4}|[ivxlcdm]{1,6}|(?:page|p\.)\s*\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?|\d{1,4}\s*\/\s*\d{1,4})\s*$/iu;

/** 문장 끝 문장부호(닫는 따옴표·괄호 허용). */
export const SENTENCE_END = /[.!?。．！？:;]["'”’)\]」』]*\s*$/u;

/** 대문자·숫자·여는 따옴표로 시작(라틴 새 문장 신호). */
export const STARTS_UPPER = /^\s*["'“‘([]?[A-Z0-9À-ÖØ-Þ]/u;

export const STARTS_LOWER = /^\s*[a-zà-öø-ÿ]/u;
