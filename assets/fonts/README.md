# Font assets

| File | Source | Processing | Size | sha256 | License |
|---|---|---|---|---|---|
| `NotoSansKR-Regular-subset.ttf` | Google Fonts `ofl/notosanskr/NotoSansKR[wght].ttf` (10,414,588 B, sha256 `194018e6…e252`) | fontTools 4.62.1: `wght=400` static instance → subset (Hangul syllables U+AC00–D7A3, compatibility jamo, Basic Latin, Latin-1, general punctuation, €, ™, CJK symbols, fullwidth forms, KS X 1001 Hanja). One-to-one cmap (one code point per glyph) | 4,082,236 B, 16,966 glyphs, cmap 16,567 characters | `e96d7e433dfce68846113fcbaa0d7c3c69744a08465e0c89a7fd4f0205b9a287` | OFL-1.1 (`OFL.txt`) |

- Regenerate: `scripts/fonts/build-noto-sans-kr-subset.sh` (checks the source sha256; with a fixed `SOURCE_DATE_EPOCH` the same hash was reproduced on 2026-10-18; the edition with Hanja, € and ™ added on 2026-10-19).
- Hanja, € and ™ added: `docs/m3-contract.md` D12 (user decision 2026-10-19). The previous edition was 2,556,960 B, 12,267 glyphs (sha256 `07964042…bf02`). The 4,888 KS X 1001 Hanja become 4,622 characters under NFC, of which 4,619 are included. The 3 missing characters (U+9699, U+90CE, U+96B8) are not in the source font.
- One-to-one cmap (same contract, amendment 2): in the source, several code points share one glyph, and the ToUnicode written by MuPDF `addFont` picked the largest of them (space → U+00A0, unified Hanja → compatibility Hanja, compatibility jamo → halfwidth jamo). Therefore compatibility Hanja U+F900–FAFF, halfwidth jamo U+FFA0–FFDC, and U+00A0, U+00AD, U+2011, U+2003, U+2012, U+301C, U+FF40 were removed. On 2026-10-19, with MuPDF 1.28.1, the gid → extraction round trip matched for all 16,564 code points excluding whitespace characters.
- `src/` (not in git) receives the source variable TTF and a CFF OTF for comparison (notofonts `SubsetOTF/KR/NotoSansKR-Regular.otf`, 4,644,748 B).
- Why glyf (TrueType): when a CFF OTF is added with MuPDF 1.28.1 `addFont`, Hangul glyphs break when the document is reopened and rendered, and `subsetFonts()` fails (`docs/m0-day1-log.md`).
