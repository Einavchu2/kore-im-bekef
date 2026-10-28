// Display text -> text sent to the speech engine.
// The display text (exact spelling + approved niqqud) is never changed; only the engine input may differ.
// Order: adult-approved override (saved from the review page) > built-in rule for single-letter syllables > the text itself.
const KAMATZ = "\u05B8", PATACH = "\u05B7", SHVA = "\u05B0", SEGOL = "\u05B6";
const NIQQUD = /[\u0591-\u05C7]/g;
export const strip = (s) => s.replace(NIQQUD, "");

// Letter names, for a bare consonant that cannot be pronounced on its own.
export const LETTER_NAMES = {
  "א": "אָלֶף", "ב": "בֵּית", "ג": "גִּימֶל", "ד": "דָּלֶת", "ה": "הֵא", "ו": "וָו", "ז": "זַיִן", "ח": "חֵית", "ט": "טֵית",
  "י": "יוֹד", "כ": "כַּף", "ל": "לָמֶד", "מ": "מֵם", "נ": "נוּן", "ס": "סָמֶךְ", "ע": "עַיִן", "פ": "פֵּא", "צ": "צָדִי",
  "ק": "קוֹף", "ר": "רֵישׁ", "ש": "שִׁין", "ת": "תָּו",
  "ם": "מֵם סוֹפִית", "ן": "נוּן סוֹפִית", "ף": "פֵּא סוֹפִית", "ך": "כַּף סוֹפִית", "ץ": "צָדִי סוֹפִית",
};

function vowelOf(u) {
  if (u.includes(KAMATZ) || u.includes(PATACH)) return "a";
  if (u.includes(SHVA)) return "e";
  return "n";
}

// Same rule the app uses on the device voice: a lone consonant+vowel is voiced as an open syllable.
//   דָ / דַ  -> דָה  ("da")      דְ -> דֶה ("de", vocal shva at the start of a word)
//   bare letter -> its name     anything longer than one letter -> unchanged
export function syllableRule(u) {
  if (strip(u).length >= 2) return u;
  const v = vowelOf(u);
  if (v === "a") return u + "ה";
  if (v === "e") return u.replace(SHVA, SEGOL) + "ה";
  return LETTER_NAMES[strip(u)] || u;
}

export function engineText(text, kind, overrides = {}) {
  const key = `${kind}|${text}`;
  if (overrides[key]) return { sendText: overrides[key], rule: "override" };
  if (kind === "syllable") {
    const t = syllableRule(text);
    return { sendText: t, rule: t === text ? "as-is" : "syllable-rule" };
  }
  return { sendText: text, rule: "as-is" };
}
