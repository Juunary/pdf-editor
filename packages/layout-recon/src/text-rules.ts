/** Text patterns (bullets, captions, page numbers, sentence ends). */

/** Start of a bullet or numbered list item. */
export const BULLET =
  /^\s*(?:\[\d{1,3}\](?=\s)|[•◦▪▫●○■□►▶‣⁃∙·–—*»›➢➤✓✔❖◆◇❑⚪◎※☐▸▹◼⦁∘-]|ㅇ(?=\s)|[ㄱ-ㅎ][.)](?=\s)|[①-⑳]|\(\d{1,2}\)|\d{1,2}[.)](?=\s)|[a-z][.)](?=\s)|[A-Z]\)(?=\s)|[가-하][.)](?=\s)|\([a-zA-Z가-하]\)|[ivxIVX]{1,4}[.)](?=\s))/u;

/** Numbered heading ("1.", "2.3", "제 1 장", "IV."). */
export const NUMBERED_HEADING = /^\s*(?:\d+(?:\.\d+)*\.?|[IVX]{1,5}\.|제\s*\d+\s*[장절편])\s+\S/u;

export const CAPTION =
  /^\s*(?:Figure|Fig\.|Table|Exhibit|Chart|Box|Plate|그림|표|도표|사진|<\s*(?:표|그림)|\[\s*(?:표|그림))\s*[A-Z]?\d/iu;

/** Page number format. */
export const PAGE_NUMBER =
  /^\s*(?:[-–—]\s*\d{1,4}\s*[-–—]|\d{1,4}|[ivxlcdm]{1,6}|(?:page|p\.)\s*\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?|\d{1,4}\s*\/\s*\d{1,4})\s*$/iu;

/** Sentence-ending punctuation (closing quotes and brackets allowed). */
export const SENTENCE_END = /[.!?。．！？:;]["'”’)\]」』]*\s*$/u;

/** Starts with an uppercase letter, digit or opening quote (Latin new-sentence signal). */
export const STARTS_UPPER = /^\s*["'“‘([]?[A-Z0-9À-ÖØ-Þ]/u;

export const STARTS_LOWER = /^\s*[a-zà-öø-ÿ]/u;

/** TeX/OpenType math font names (after the subset prefix). */
export const MATH_FONT =
  /^(?:[A-Z]{6}\+)?(?:CMMI|CMSY|CMEX|CMBSY|CMMIB|MSAM|MSBM|EUSM|EUFM|EUEX|RSFS|LMMathItalic|LMMathSymbols|LMMathExtension|txsy|txmi|txex|pxsy|pxmi|pxex|MTMI|MTSY|MTEX|STIXMath|STIXTwoMath|CambriaMath|Cambria-Math|XITSMath|LatinModernMath|Asana)/i;
/** Math symbol code ranges (arrows, operators, miscellaneous math symbols, math alphanumerics). */
export const MATH_CHAR = /[←-⇿∀-⋿⟀-⟯⦀-⫿\u{1D400}-\u{1D7FF}]/u;
