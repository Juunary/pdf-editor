/**
 * Data tables for pdf-fonts.ts. Reproduces MuPDF 1.28's encoding tables (fz_glyph_name_from_*) and predefined CMap codespaces
 * with the same values. Glyph name → Unicode is a subset of the Adobe Glyph List (all names used in the encoding tables +
 * common Differences names), not the full AGL.
 */

/** Code → glyph name (256 slots, undefined = null) */
export type EncodingTable = readonly (string | null)[];

type Segment = readonly [start: number, names: string];

function table(segments: readonly Segment[]): EncodingTable {
  const out: (string | null)[] = new Array<string | null>(256).fill(null);
  for (const [start, names] of segments) {
    names.split(/\s+/).forEach((n, i) => {
      out[start + i] = n === '-' ? null : n;
    });
  }
  return out;
}

const range = (from: number, to: number, f: (c: number) => string): string =>
  Array.from({ length: to - from + 1 }, (_, i) => f(from + i)).join(' ');
const UPPER = range(65, 90, (c) => String.fromCharCode(c));
const LOWER = range(97, 122, (c) => String.fromCharCode(c));
const DIGITS = 'zero one two three four five six seven eight nine';
/** Codes 32–126. Only 39 and 96 differ between encodings. */
const ascii = (c39: string, c96: string): string =>
  `space exclam quotedbl numbersign dollar percent ampersand ${c39} parenleft parenright asterisk plus comma hyphen period slash ` +
  `${DIGITS} colon semicolon less equal greater question at ${UPPER} bracketleft backslash bracketright asciicircum underscore ${c96} ` +
  `${LOWER} braceleft bar braceright asciitilde`;

export const STANDARD_ENCODING: EncodingTable = table([
  [32, ascii('quoteright', 'quoteleft')],
  [
    161,
    'exclamdown cent sterling fraction yen florin section currency quotesingle quotedblleft guillemotleft guilsinglleft guilsinglright fi fl',
  ],
  [177, 'endash dagger daggerdbl periodcentered'],
  [
    182,
    'paragraph bullet quotesinglbase quotedblbase quotedblright guillemotright ellipsis perthousand',
  ],
  [191, 'questiondown'],
  [193, 'grave acute circumflex tilde macron breve dotaccent dieresis'],
  [202, 'ring cedilla'],
  [205, 'hungarumlaut ogonek caron emdash'],
  [225, 'AE'],
  [227, 'ordfeminine'],
  [232, 'Lslash Oslash OE ordmasculine'],
  [241, 'ae'],
  [245, 'dotlessi'],
  [248, 'lslash oslash oe germandbls'],
]);

export const WIN_ANSI_ENCODING: EncodingTable = table([
  [32, ascii('quotesingle', 'grave')],
  [
    127,
    'bullet Euro bullet quotesinglbase florin quotedblbase ellipsis dagger daggerdbl circumflex perthousand Scaron guilsinglleft OE bullet Zcaron bullet',
  ],
  [
    144,
    'bullet quoteleft quoteright quotedblleft quotedblright bullet endash emdash tilde trademark scaron guilsinglright oe bullet zcaron Ydieresis',
  ],
  [
    160,
    'space exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered macron',
  ],
  [
    176,
    'degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown',
  ],
  [
    192,
    'Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis',
  ],
  [
    208,
    'Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls',
  ],
  [
    224,
    'agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis',
  ],
  [
    240,
    'eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis',
  ],
]);

/** MacRomanEncoding from PDF Appendix D (the math symbol slots are empty). */
export const MAC_ROMAN_ENCODING: EncodingTable = table([
  [32, ascii('quotesingle', 'grave')],
  [
    128,
    'Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave',
  ],
  [
    144,
    'ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis',
  ],
  [
    160,
    'dagger degree cent sterling section bullet paragraph germandbls registered copyright trademark acute dieresis - AE Oslash',
  ],
  [176, '- plusminus - - yen mu - - - - - ordfeminine ordmasculine - ae oslash'],
  [
    192,
    'questiondown exclamdown logicalnot - florin - - guillemotleft guillemotright ellipsis space Agrave Atilde Otilde OE oe',
  ],
  [
    208,
    'endash emdash quotedblleft quotedblright quoteleft quoteright divide - ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl',
  ],
  [
    224,
    'daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex',
  ],
  [
    240,
    '- Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron',
  ],
]);

/** Glyph name → Unicode (hex). Each line lists `name value` pairs separated by spaces. */
const AGL = `
space 20 exclam 21 quotedbl 22 numbersign 23 dollar 24 percent 25 ampersand 26 quotesingle 27 quoteright 2019
parenleft 28 parenright 29 asterisk 2A plus 2B comma 2C hyphen 2D period 2E slash 2F
zero 30 one 31 two 32 three 33 four 34 five 35 six 36 seven 37 eight 38 nine 39 colon 3A semicolon 3B
less 3C equal 3D greater 3E question 3F at 40
bracketleft 5B backslash 5C bracketright 5D asciicircum 5E underscore 5F grave 60 quoteleft 2018
braceleft 7B bar 7C braceright 7D asciitilde 7E
exclamdown A1 cent A2 sterling A3 fraction 2044 yen A5 florin 192 section A7 currency A4
quotedblleft 201C guillemotleft AB guilsinglleft 2039 guilsinglright 203A fi FB01 fl FB02
endash 2013 dagger 2020 daggerdbl 2021 periodcentered B7 paragraph B6 bullet 2022
quotesinglbase 201A quotedblbase 201E quotedblright 201D guillemotright BB ellipsis 2026 perthousand 2030
questiondown BF acute B4 circumflex 2C6 tilde 2DC macron AF breve 2D8 dotaccent 2D9 dieresis A8
ring 2DA cedilla B8 hungarumlaut 2DD ogonek 2DB caron 2C7 emdash 2014
AE C6 ordfeminine AA Lslash 141 Oslash D8 OE 152 ordmasculine BA ae E6 dotlessi 131 lslash 142 oslash F8 oe 153 germandbls DF
Euro 20AC Scaron 160 scaron 161 Zcaron 17D zcaron 17E Ydieresis 178 trademark 2122
brokenbar A6 copyright A9 logicalnot AC registered AE degree B0 plusminus B1 twosuperior B2 threesuperior B3
mu B5 onesuperior B9 onequarter BC onehalf BD threequarters BE multiply D7 divide F7 Eth D0 eth F0 Thorn DE thorn FE
Agrave C0 Aacute C1 Acircumflex C2 Atilde C3 Adieresis C4 Aring C5 Ccedilla C7 Egrave C8 Eacute C9 Ecircumflex CA
Edieresis CB Igrave CC Iacute CD Icircumflex CE Idieresis CF Ntilde D1 Ograve D2 Oacute D3 Ocircumflex D4 Otilde D5
Odieresis D6 Ugrave D9 Uacute DA Ucircumflex DB Udieresis DC Yacute DD
agrave E0 aacute E1 acircumflex E2 atilde E3 adieresis E4 aring E5 ccedilla E7 egrave E8 eacute E9 ecircumflex EA
edieresis EB igrave EC iacute ED icircumflex EE idieresis EF ntilde F1 ograve F2 oacute F3 ocircumflex F4 otilde F5
odieresis F6 ugrave F9 uacute FA ucircumflex FB udieresis FC yacute FD ydieresis FF
notequal 2260 infinity 221E lessequal 2264 greaterequal 2265 partialdiff 2202 summation 2211 product 220F pi 3C0
integral 222B Omega 2126 radical 221A approxequal 2248 Delta 2206 lozenge 25CA apple F8FF
nbspace A0 nonbreakingspace A0 sfthyphen AD minus 2212 mu1 B5 increment 2206 ff FB00 ffi FB03 ffl FB04
quotereversed 201B underscoredbl 2017 figuredash 2012 horizontalbar 2015 hyphentwo 2010 filledbox 25A0
zerosuperior 2070 foursuperior 2074 fivesuperior 2075 sixsuperior 2076 sevensuperior 2077 eightsuperior 2078 ninesuperior 2079
onethird 2153 twothirds 2154 oneeighth 215B threeeighths 215C fiveeighths 215D seveneighths 215E
Alpha 391 Beta 392 Gamma 393 Epsilon 395 Zeta 396 Eta 397 Theta 398 Iota 399 Kappa 39A Lambda 39B Mu 39C Nu 39D Xi 39E
Omicron 39F Pi 3A0 Rho 3A1 Sigma 3A3 Tau 3A4 Upsilon 3A5 Phi 3A6 Chi 3A7 Psi 3A8
alpha 3B1 beta 3B2 gamma 3B3 delta 3B4 epsilon 3B5 zeta 3B6 eta 3B7 theta 3B8 iota 3B9 kappa 3BA lambda 3BB nu 3BD
xi 3BE omicron 3BF rho 3C1 sigma1 3C2 sigma 3C3 tau 3C4 upsilon 3C5 phi 3C6 chi 3C7 psi 3C8 omega 3C9
Abreve 102 abreve 103 Amacron 100 amacron 101 Aogonek 104 aogonek 105 Cacute 106 cacute 107 Ccircumflex 108 ccircumflex 109
Cdotaccent 10A cdotaccent 10B Ccaron 10C ccaron 10D Dcaron 10E dcaron 10F Dcroat 110 dcroat 111 Emacron 112 emacron 113
Ebreve 114 ebreve 115 Edotaccent 116 edotaccent 117 Eogonek 118 eogonek 119 Ecaron 11A ecaron 11B Gcircumflex 11C gcircumflex 11D
Gbreve 11E gbreve 11F Gdotaccent 120 gdotaccent 121 Gcommaaccent 122 gcommaaccent 123 Hcircumflex 124 hcircumflex 125
Hbar 126 hbar 127 Itilde 128 itilde 129 Imacron 12A imacron 12B Ibreve 12C ibreve 12D Iogonek 12E iogonek 12F
Idotaccent 130 IJ 132 ij 133 Jcircumflex 134 jcircumflex 135 Kcommaaccent 136 kcommaaccent 137 kgreenlandic 138
Lacute 139 lacute 13A Lcommaaccent 13B lcommaaccent 13C Lcaron 13D lcaron 13E Ldot 13F ldot 140
Nacute 143 nacute 144 Ncommaaccent 145 ncommaaccent 146 Ncaron 147 ncaron 148 napostrophe 149 Eng 14A eng 14B
Omacron 14C omacron 14D Obreve 14E obreve 14F Ohungarumlaut 150 ohungarumlaut 151
Racute 154 racute 155 Rcommaaccent 156 rcommaaccent 157 Rcaron 158 rcaron 159 Sacute 15A sacute 15B
Scircumflex 15C scircumflex 15D Scedilla 15E scedilla 15F Tcommaaccent 162 tcommaaccent 163 Tcaron 164 tcaron 165
Tbar 166 tbar 167 Utilde 168 utilde 169 Umacron 16A umacron 16B Ubreve 16C ubreve 16D Uring 16E uring 16F
Uhungarumlaut 170 uhungarumlaut 171 Uogonek 172 uogonek 173 Wcircumflex 174 wcircumflex 175 Ycircumflex 176 ycircumflex 177
Zacute 179 zacute 17A Zdotaccent 17B zdotaccent 17C longs 17F Ohorn 1A0 ohorn 1A1 Uhorn 1AF uhorn 1B0 dotlessj 237
`;

const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const NAME_TO_UNICODE: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  const tokens = AGL.trim().split(/\s+/);
  for (let i = 0; i + 1 < tokens.length; i += 2) m.set(tokens[i]!, parseInt(tokens[i + 1]!, 16));
  for (const ch of upper) {
    m.set(ch, ch.charCodeAt(0));
    m.set(ch.toLowerCase(), ch.toLowerCase().charCodeAt(0));
  }
  return m;
})();

/** All glyph names in the table (for tests and diagnostics) */
export const KNOWN_GLYPH_NAMES: readonly string[] = [...NAME_TO_UNICODE.keys()];

/**
 * Glyph name → Unicode (only names in the table). Measuring the built-in font Differences on 1.28.1 shows that a name is found only when it matches the font's glyph name
 * exactly (or when an AGL duplicate name or a `uniXXXX` glyph exists), and synthesized names like `A.alt`, `u2022` and `uni00E9` are mostly
 * not found and fall back to the built-in encoding glyph. So names outside the table are null (the caller marks them unresolved).
 */
export function glyphNameToUnicode(name: string): number | null {
  return NAME_TO_UNICODE.get(name) ?? null;
}

type Run = readonly [lo: number, hi: number, firstGid: number];

/**
 * Built-in encoding of MuPDF's built-in Symbol and ZapfDingbats (code → glyph index). Values measured from the Device callback gid on 1.28.1,
 * and the gid increases by 1 within each contiguous run of defined codes. Codes not in the table are .notdef (0).
 */
const SYMBOL_RUNS: readonly Run[] = [
  [32, 126, 1],
  [128, 128, 96],
  [160, 239, 97],
  [241, 254, 177],
];
const ZAPF_RUNS: readonly Run[] = [
  [32, 126, 1],
  [128, 141, 96],
  [161, 239, 110],
  [241, 254, 189],
];

function runsToTable(runs: readonly Run[]): readonly number[] {
  const out = new Array<number>(256).fill(0);
  for (const [lo, hi, gid] of runs) for (let c = lo; c <= hi; c++) out[c] = gid + (c - lo);
  return out;
}

export const SYMBOL_BUILTIN_GIDS: readonly number[] = runsToTable(SYMBOL_RUNS);
export const ZAPF_BUILTIN_GIDS: readonly number[] = runsToTable(ZAPF_RUNS);

/** Codespace ranges. n = number of bytes */
export interface CodespaceRange {
  n: number;
  low: number;
  high: number;
}

const cs = (n: number, low: number, high: number): CodespaceRange => ({ n, low, high });
// The UCS2 family in Adobe cmap-resources has two ranges excluding the surrogate area (confirmed on 1.28.1 that D800 is not a 2-byte code)
const UCS2 = [cs(2, 0x0000, 0xd7ff), cs(2, 0xe000, 0xffff)];
const UTF16 = [cs(2, 0x0000, 0xd7ff), cs(4, 0xd800dc00, 0xdbffdfff), cs(2, 0xe000, 0xffff)];
const EUC_A1 = [cs(1, 0x00, 0x80), cs(2, 0xa1a1, 0xfefe)];
const GBK = [cs(1, 0x00, 0x80), cs(2, 0x8140, 0xfefe)];
const RKSJ = [cs(1, 0x00, 0x80), cs(2, 0x8140, 0x9ffc), cs(1, 0xa0, 0xdf), cs(2, 0xe040, 0xfcfc)];
const RKSJ_PV = [...RKSJ, cs(1, 0xfd, 0xff)];
const B5_A1 = [cs(1, 0x00, 0x80), cs(2, 0xa140, 0xfefe)];

/**
 * Predefined CMap name (base name with the -H/-V suffix removed) → codespace. The codespacerange of Adobe cmap-resources (Ghostscript and poppler distributions),
 * and it does not include CID mapping. The key set is the predefined CMaps MuPDF 1.28.1 (WASM) actually reads (56 measured, excluding Identity).
 * guessed: entries partly estimated because the distribution and MuPDF were observed to differ (CNS-EUC: MuPDF also accepts the 8EA4 and 8EA7 planes).
 */
export const PREDEFINED_CMAP_CODESPACES: Readonly<
  Record<string, { codespaces: readonly CodespaceRange[]; guessed?: boolean }>
> = {
  'GB-EUC': { codespaces: EUC_A1 },
  'GBpc-EUC': { codespaces: [cs(1, 0x00, 0x80), cs(2, 0xa1a1, 0xfcfe), cs(1, 0xfd, 0xff)] },
  'GBK-EUC': { codespaces: GBK },
  'GBKp-EUC': { codespaces: GBK },
  GBK2K: { codespaces: [cs(1, 0x00, 0x7f), cs(4, 0x81308130, 0xfe39fe39), cs(2, 0x8140, 0xfefe)] },
  'UniGB-UCS2': { codespaces: UCS2 },
  'UniGB-UTF16': { codespaces: UTF16 },
  B5pc: { codespaces: [cs(1, 0x00, 0x80), cs(2, 0xa140, 0xfcfe), cs(1, 0xfd, 0xff)] },
  'HKscs-B5': { codespaces: [cs(1, 0x00, 0x80), cs(2, 0x8740, 0xfefe)] },
  'ETen-B5': { codespaces: B5_A1 },
  'ETenms-B5': { codespaces: B5_A1 },
  'CNS-EUC': {
    codespaces: [
      cs(1, 0x00, 0x80),
      cs(4, 0x8ea1a1a1, 0x8ea1fefe),
      cs(4, 0x8ea2a1a1, 0x8ea2fefe),
      cs(4, 0x8ea3a1a1, 0x8ea3fefe),
      cs(4, 0x8ea4a1a1, 0x8ea4fefe),
      cs(4, 0x8ea5a1a1, 0x8ea5fefe),
      cs(4, 0x8ea6a1a1, 0x8ea6fefe),
      cs(4, 0x8ea7a1a1, 0x8ea7fefe),
      cs(2, 0xa1a1, 0xfefe),
    ],
    guessed: true,
  },
  'UniCNS-UCS2': { codespaces: UCS2 },
  'UniCNS-UTF16': { codespaces: UTF16 },
  '83pv-RKSJ': { codespaces: RKSJ_PV },
  '90ms-RKSJ': { codespaces: RKSJ },
  '90msp-RKSJ': { codespaces: RKSJ },
  '90pv-RKSJ': { codespaces: RKSJ_PV },
  'Add-RKSJ': { codespaces: RKSJ },
  'Ext-RKSJ': { codespaces: RKSJ },
  EUC: { codespaces: [cs(1, 0x00, 0x80), cs(2, 0x8ea0, 0x8edf), cs(2, 0xa1a1, 0xfefe)] },
  '': { codespaces: [cs(2, 0x2121, 0x7e7e)] },
  'UniJIS-UCS2': { codespaces: UCS2 },
  'UniJIS-UCS2-HW': { codespaces: UCS2 },
  'UniJIS-UTF16': { codespaces: UTF16 },
  'KSC-EUC': { codespaces: EUC_A1 },
  'KSCms-UHC': { codespaces: [cs(1, 0x00, 0x80), cs(2, 0x8141, 0xfefe)] },
  'KSCms-UHC-HW': { codespaces: [cs(1, 0x00, 0x80), cs(2, 0x8141, 0xfefe)] },
  'KSCpc-EUC': { codespaces: [cs(1, 0x00, 0x84), cs(2, 0xa141, 0xfdfe), cs(1, 0xfe, 0xff)] },
  'UniKS-UCS2': { codespaces: UCS2 },
  'UniKS-UTF16': { codespaces: UTF16 },
};

/** -V combinations MuPDF 1.28.1 cannot read (measured). These names fail to load → hail-mary. */
const NO_V_VARIANT = new Set(['83pv-RKSJ', '90pv-RKSJ', 'KSCpc-EUC']);

/**
 * Predefined CMap name resolution. 'H' and 'V' are Japanese JIS CMaps whose base name is an empty string.
 * null if MuPDF does not know the name.
 */
export function lookupPredefinedCMap(
  name: string,
): { codespaces: readonly CodespaceRange[]; wmode: 0 | 1; guessed: boolean } | null {
  let base: string;
  if (name === 'H' || name === 'V') base = '';
  else {
    const m = /^(.+)-([HV])$/.exec(name);
    if (!m) return null;
    base = m[1]!;
  }
  const entry = PREDEFINED_CMAP_CODESPACES[base];
  if (!entry) return null;
  const wmode = name.endsWith('V') ? 1 : 0;
  if (wmode === 1 && NO_V_VARIANT.has(base)) return null;
  return { codespaces: entry.codespaces, wmode, guessed: entry.guessed === true };
}
