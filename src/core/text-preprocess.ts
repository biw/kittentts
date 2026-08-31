export interface TextPreprocessorOptions {
  lowercase?: boolean;
  replaceNumbers?: boolean;
  replaceFloats?: boolean;
  expandContractions?: boolean;
  expandOrdinals?: boolean;
  expandPercentages?: boolean;
  expandCurrency?: boolean;
  expandTime?: boolean;
  expandRanges?: boolean;
  expandModelNames?: boolean;
  expandUnits?: boolean;
  expandScaleSuffixes?: boolean;
  expandScientificNotation?: boolean;
  expandFractions?: boolean;
  expandDecades?: boolean;
  expandPhoneNumbers?: boolean;
  expandIpAddresses?: boolean;
  normalizeLeadingDecimals?: boolean;
  removeUrls?: boolean;
  removeEmails?: boolean;
  removeHtml?: boolean;
  removePunctuation?: boolean;
  normalizeUnicode?: boolean;
  removeExtraWhitespace?: boolean;
}

const ONES = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALE = ["", "thousand", "million", "billion", "trillion"];
const ORDINAL_EXCEPTIONS: Record<string, string> = {
  one: "first",
  two: "second",
  three: "third",
  four: "fourth",
  five: "fifth",
  six: "sixth",
  seven: "seventh",
  eight: "eighth",
  nine: "ninth",
  twelve: "twelfth",
};
const CURRENCY_SYMBOLS: Record<string, string> = {
  "$": "dollar",
  "€": "euro",
  "£": "pound",
  "¥": "yen",
  "₹": "rupee",
  "₩": "won",
  "₿": "bitcoin",
};
const RE_URL = /https?:\/\/\S+|www\.\S+/gi;
const RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi;
const RE_HTML = /<[^>]+>/g;
const RE_SPACES = /\s+/g;
const RE_PUNCT = /[^\w\s.,?!;:\-\u2014\u2013\u2026]/gu;
const RE_NUMBER = /(?<![a-zA-Z])-?\d[\d,]*(?:\.\d+)?/g;
const RE_ORDINAL = /\b(\d+)(st|nd|rd|th)\b/gi;
const RE_PERCENT = /(-?[\d,]+(?:\.\d+)?)\s*%/g;
const RE_CURRENCY = /([$€£¥₹₩₿])\s*([\d,]+(?:\.\d+)?)\s*([KMBT])?(?![a-zA-Z\d])/g;
const RE_TIME = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\b/gi;
const RE_RANGE = /(?<!\w)(\d+)-(\d+)(?!\w)/g;
const RE_MODEL_VER = /\b([a-zA-Z][a-zA-Z0-9]*)-(\d[\d.]*)(?=[^\d.]|$)/g;
const RE_UNIT = /(\d+(?:\.\d+)?)\s*(km|kg|mg|ml|gb|mb|kb|tb|hz|khz|mhz|ghz|mph|kph|°[cCfF]|[cCfF]°|ms|ns|µs)\b/gi;
const RE_SCALE_SUFFIX = /(?<![a-zA-Z])(\d+(?:\.\d+)?)\s*([KMBT])(?![a-zA-Z\d])/g;
const RE_SCIENTIFIC = /(?<![a-zA-Z\d])(-?\d+(?:\.\d+)?)[eE]([+-]?\d+)(?![a-zA-Z\d])/g;
const RE_FRACTION = /\b(\d+)\s*\/\s*(\d+)\b/g;
const RE_DECADE = /\b(\d{1,3})0s\b/g;
const RE_IP_ADDRESS = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
const RE_LEAD_DEC = /(?<!\d)\.([\d])/g;
const NON_BOUNDARY_ABBREVIATIONS = new Set([
  "dr", "prof", "mr", "mrs", "ms", "fig", "figs", "pp", "p", "ch", "sec",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
  "nov", "dec", "al",
]);

function threeDigitsToWords(value: number): string {
  if (value === 0) {
    return "";
  }
  const parts: string[] = [];
  const hundreds = Math.floor(value / 100);
  const remainder = value % 100;
  if (hundreds) {
    parts.push(`${ONES[hundreds]} hundred`);
  }
  if (remainder < 20) {
    if (remainder) {
      parts.push(ONES[remainder]);
    }
  } else {
    const tensWord = TENS[Math.floor(remainder / 10)];
    const onesWord = ONES[remainder % 10];
    parts.push(onesWord ? `${tensWord}-${onesWord}` : tensWord);
  }
  return parts.join(" ");
}

export function numberToWords(value: number): string {
  let n = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(n) || Math.abs(n) > 999_999_999_999_999) {
    throw new RangeError("number must be a safe integer between -999999999999999 and 999999999999999");
  }
  if (n === 0) {
    return "zero";
  }
  if (n < 0) {
    return `negative ${numberToWords(-n)}`;
  }
  if (n >= 100 && n <= 9999 && n % 100 === 0 && n % 1000 !== 0) {
    const hundreds = Math.floor(n / 100);
    if (hundreds < 20) {
      return `${ONES[hundreds]} hundred`;
    }
  }

  const parts: string[] = [];
  for (let scaleIndex = 0; scaleIndex < SCALE.length; scaleIndex += 1) {
    const chunk = n % 1000;
    if (chunk) {
      const chunkWords = threeDigitsToWords(chunk);
      parts.push(SCALE[scaleIndex] ? `${chunkWords} ${SCALE[scaleIndex]}` : chunkWords);
    }
    n = Math.floor(n / 1000);
    if (n === 0) {
      break;
    }
  }
  return parts.reverse().join(" ");
}

export function floatToWords(value: number | string, decimalSep = "point"): string {
  let text = typeof value === "string" ? value : String(value);
  const negative = text.startsWith("-");
  if (negative) {
    text = text.slice(1);
  }

  const result = text.includes(".")
    ? (() => {
        const [intPart, decPart] = text.split(".", 2);
        const intWords = intPart ? numberToWords(Number.parseInt(intPart, 10)) : "zero";
        const decWords = decPart
          .split("")
          .map((digit) => (digit === "0" ? "zero" : ONES[Number.parseInt(digit, 10)]))
          .join(" ");
        return `${intWords} ${decimalSep} ${decWords}`;
      })()
    : numberToWords(Number.parseInt(text, 10));

  return negative ? `negative ${result}` : result;
}

export function ordinalToWords(value: number): string {
  const words = numberToWords(value);
  const separatorIndex = Math.max(words.lastIndexOf("-"), words.lastIndexOf(" "));
  const prefix = separatorIndex >= 0 ? words.slice(0, separatorIndex + 1) : "";
  const last = separatorIndex >= 0 ? words.slice(separatorIndex + 1) : words;
  const ordinal =
    ORDINAL_EXCEPTIONS[last] ??
    (last.endsWith("t") ? `${last}h` : last.endsWith("e") ? `${last.slice(0, -1)}th` : `${last}th`);
  return `${prefix}${ordinal}`;
}

export function expandOrdinals(text: string): string {
  return text.replace(RE_ORDINAL, (_, value: string) => ordinalToWords(Number.parseInt(value, 10)));
}

export function normalizeUnicode(text: string, form = "NFC"): string {
  let wellFormed = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        wellFormed += text[index] + text[index + 1];
        index += 1;
      } else {
        wellFormed += " ";
      }
      continue;
    }
    wellFormed += code >= 0xdc00 && code <= 0xdfff ? " " : text[index];
  }
  return wellFormed.normalize(form as "NFC" | "NFD" | "NFKC" | "NFKD");
}

export function removeHtmlTags(text: string): string {
  return text.replace(RE_HTML, " ");
}

export function removeUrls(text: string, replacement = ""): string {
  return text.replace(RE_URL, replacement).trim();
}

export function removeEmails(text: string, replacement = ""): string {
  return text.replace(RE_EMAIL, replacement).trim();
}

export function expandContractions(text: string): string {
  const contractions: Array<[RegExp, string]> = [
    [/\bcan't\b/gi, "cannot"],
    [/\bwon't\b/gi, "will not"],
    [/\bshan't\b/gi, "shall not"],
    [/\bain't\b/gi, "is not"],
    [/\blet's\b/gi, "let us"],
    [/\b(\w+)n't\b/gi, "$1 not"],
    [/\b(\w+)'re\b/gi, "$1 are"],
    [/\b(\w+)'ve\b/gi, "$1 have"],
    [/\b(\w+)'ll\b/gi, "$1 will"],
    [/\b(\w+)'d\b/gi, "$1 would"],
    [/\b(\w+)'m\b/gi, "$1 am"],
    [/\bit's\b/gi, "it is"],
  ];
  let expanded = text;
  for (const [pattern, replacement] of contractions) {
    expanded = expanded.replace(pattern, replacement);
  }
  return expanded;
}

export function normalizeLeadingDecimals(text: string): string {
  return text.replace(/(?<!\d)(-)\.([\d])/g, "$10.$2").replace(RE_LEAD_DEC, "0.$1");
}

export function expandCurrency(text: string): string {
  const scaleMap: Record<string, string> = {
    K: "thousand",
    M: "million",
    B: "billion",
    T: "trillion",
  };

  return text.replace(RE_CURRENCY, (_, symbol: string, rawValue: string, scaleSuffix?: string) => {
    const raw = rawValue.replace(/,/g, "");
    const unit = CURRENCY_SYMBOLS[symbol] ?? "";

    if (scaleSuffix) {
      const scaleWord = scaleMap[scaleSuffix];
      const num = raw.includes(".") ? floatToWords(raw) : numberToWords(Number.parseInt(raw, 10));
      return `${num} ${scaleWord} ${unit}${unit ? "s" : ""}`.trim();
    }

    if (raw.includes(".")) {
      const [intPart, decPart] = raw.split(".", 2);
      const decValue = Number.parseInt(decPart.slice(0, 2).padEnd(2, "0"), 10);
      let result = `${numberToWords(Number.parseInt(intPart, 10))} ${unit}s`.trim();
      if (decValue) {
        result += ` and ${numberToWords(decValue)} cent${decValue === 1 ? "" : "s"}`;
      }
      return result;
    }

    const value = Number.parseInt(raw, 10);
    const words = numberToWords(value);
    return unit ? `${words} ${unit}${value === 1 ? "" : "s"}` : words;
  });
}

export function expandPercentages(text: string): string {
  return text.replace(RE_PERCENT, (_, rawValue: string) => {
    const raw = rawValue.replace(/,/g, "");
    return raw.includes(".")
      ? `${floatToWords(raw)} percent`
      : `${numberToWords(Number.parseInt(raw, 10))} percent`;
  });
}

export function expandTime(text: string): string {
  return text.replace(RE_TIME, (_, hours: string, minutes: string, _seconds: string, suffix?: string) => {
    const h = Number.parseInt(hours, 10);
    const mins = Number.parseInt(minutes, 10);
    const normalizedSuffix = suffix ? ` ${suffix.toLowerCase()}` : "";
    const hourWords = numberToWords(h);
    if (mins === 0) {
      return suffix ? `${hourWords}${normalizedSuffix}` : `${hourWords} hundred`;
    }
    if (mins < 10) {
      return `${hourWords} oh ${numberToWords(mins)}${normalizedSuffix}`;
    }
    return `${hourWords} ${numberToWords(mins)}${normalizedSuffix}`;
  });
}

export function expandRanges(text: string): string {
  return text.replace(RE_RANGE, (_, lo: string, hi: string) => {
    return `${numberToWords(Number.parseInt(lo, 10))} to ${numberToWords(Number.parseInt(hi, 10))}`;
  });
}

export function expandModelNames(text: string): string {
  return text.replace(RE_MODEL_VER, "$1 $2");
}

export function expandScientificNotation(text: string): string {
  return text.replace(RE_SCIENTIFIC, (_, coefficient: string, exponent: string) => {
    const coefficientWords = coefficient.includes(".")
      ? floatToWords(coefficient)
      : numberToWords(Number.parseInt(coefficient, 10));
    const exponentValue = Number.parseInt(exponent, 10);
    const sign = exponentValue < 0 ? "negative " : "";
    return `${coefficientWords} times ten to the ${sign}${numberToWords(Math.abs(exponentValue))}`;
  });
}

export function expandUnits(text: string): string {
  const units: Record<string, string> = {
    km: "kilometers", kg: "kilograms", mg: "milligrams", ml: "milliliters",
    gb: "gigabytes", mb: "megabytes", kb: "kilobytes", tb: "terabytes",
    hz: "hertz", khz: "kilohertz", mhz: "megahertz", ghz: "gigahertz",
    mph: "miles per hour", kph: "kilometers per hour", ms: "milliseconds",
    ns: "nanoseconds", "µs": "microseconds", "°c": "degrees Celsius",
    "c°": "degrees Celsius", "°f": "degrees Fahrenheit", "f°": "degrees Fahrenheit",
  };
  return text.replace(RE_UNIT, (_, rawValue: string, rawUnit: string) => {
    const words = rawValue.includes(".") ? floatToWords(rawValue) : numberToWords(Number.parseInt(rawValue, 10));
    return `${words} ${units[rawUnit.toLowerCase()] ?? rawUnit}`;
  });
}

export function expandScaleSuffixes(text: string): string {
  const suffixes: Record<string, string> = { K: "thousand", M: "million", B: "billion", T: "trillion" };
  return text.replace(RE_SCALE_SUFFIX, (_, rawValue: string, suffix: string) => {
    const words = rawValue.includes(".") ? floatToWords(rawValue) : numberToWords(Number.parseInt(rawValue, 10));
    return `${words} ${suffixes[suffix] ?? suffix}`;
  });
}

export function expandFractions(text: string): string {
  return text.replace(RE_FRACTION, (match, numeratorRaw: string, denominatorRaw: string) => {
    const numerator = Number.parseInt(numeratorRaw, 10);
    const denominator = Number.parseInt(denominatorRaw, 10);
    if (denominator === 0) {
      return match;
    }
    let denominatorWords: string;
    if (denominator === 2) {
      denominatorWords = numerator === 1 ? "half" : "halves";
    } else if (denominator === 4) {
      denominatorWords = numerator === 1 ? "quarter" : "quarters";
    } else {
      denominatorWords = ordinalToWords(denominator) + (numerator === 1 ? "" : "s");
    }
    return `${numberToWords(numerator)} ${denominatorWords}`;
  });
}

export function expandDecades(text: string): string {
  const decades = ["hundreds", "tens", "twenties", "thirties", "forties", "fifties", "sixties", "seventies", "eighties", "nineties"];
  return text.replace(RE_DECADE, (_, baseRaw: string) => {
    const base = Number.parseInt(baseRaw, 10);
    const decade = decades[base % 10] ?? "";
    return base < 10 ? decade : `${numberToWords(Math.floor(base / 10))} ${decade}`;
  });
}

function digitsToWords(value: string): string {
  return [...value].map((digit) => (digit === "0" ? "zero" : ONES[Number.parseInt(digit, 10)])).join(" ");
}

export function expandIpAddresses(text: string): string {
  return text.replace(RE_IP_ADDRESS, (_, ...groups: string[]) => groups.slice(0, 4).map(digitsToWords).join(" dot "));
}

export function expandPhoneNumbers(text: string): string {
  const replaceGroups = (_match: string, ...groups: string[]) => groups.slice(0, -2).map(digitsToWords).join(" ");
  return text
    .replace(/(?<!\d-)(?<!\d)\b(\d{1,2})-(\d{3})-(\d{3})-(\d{4})\b(?!-\d)/g, replaceGroups)
    .replace(/(?<!\d-)(?<!\d)\b(\d{3})-(\d{3})-(\d{4})\b(?!-\d)/g, replaceGroups)
    .replace(/(?<!\d-)\b(\d{3})-(\d{4})\b(?!-\d)/g, replaceGroups);
}

export function replaceNumbers(text: string, replaceFloats = true): string {
  return text.replace(RE_NUMBER, (rawMatch) => {
    const raw = rawMatch.replace(/,/g, "");
    try {
      if (raw.includes(".") && replaceFloats) {
        return floatToWords(raw);
      }
      return numberToWords(Number.parseInt(String(Number.parseFloat(raw)), 10));
    } catch {
      return rawMatch;
    }
  });
}

export function removePunctuation(text: string): string {
  return text.replace(RE_PUNCT, " ");
}

export function toLowercase(text: string): string {
  return text.toLowerCase();
}

export function removeExtraWhitespace(text: string): string {
  return text.replace(RE_SPACES, " ").trim();
}

export class TextPreprocessor {
  private readonly options: Required<TextPreprocessorOptions>;

  constructor(options: TextPreprocessorOptions = {}) {
    this.options = {
      lowercase: true,
      replaceNumbers: true,
      replaceFloats: true,
      expandContractions: true,
      expandOrdinals: true,
      expandPercentages: true,
      expandCurrency: true,
      expandTime: true,
      expandRanges: true,
      expandModelNames: true,
      expandUnits: true,
      expandScaleSuffixes: true,
      expandScientificNotation: true,
      expandFractions: true,
      expandDecades: true,
      expandPhoneNumbers: true,
      expandIpAddresses: true,
      normalizeLeadingDecimals: true,
      removeUrls: true,
      removeEmails: true,
      removeHtml: true,
      removePunctuation: true,
      normalizeUnicode: true,
      removeExtraWhitespace: true,
      ...options,
    };
  }

  process(text: string): string {
    let result = text;
    if (this.options.normalizeUnicode) {
      result = normalizeUnicode(result);
    }
    if (this.options.removeHtml) {
      result = removeHtmlTags(result);
    }
    if (this.options.removeUrls) {
      result = removeUrls(result);
    }
    if (this.options.removeEmails) {
      result = removeEmails(result);
    }
    if (this.options.expandContractions) {
      result = expandContractions(result);
    }
    if (this.options.expandIpAddresses) {
      result = expandIpAddresses(result);
    }
    if (this.options.normalizeLeadingDecimals) {
      result = normalizeLeadingDecimals(result);
    }
    if (this.options.expandCurrency) {
      result = expandCurrency(result);
    }
    if (this.options.expandPercentages) {
      result = expandPercentages(result);
    }
    if (this.options.expandScientificNotation) {
      result = expandScientificNotation(result);
    }
    if (this.options.expandTime) {
      result = expandTime(result);
    }
    if (this.options.expandOrdinals) {
      result = expandOrdinals(result);
    }
    if (this.options.expandUnits) {
      result = expandUnits(result);
    }
    if (this.options.expandScaleSuffixes) {
      result = expandScaleSuffixes(result);
    }
    if (this.options.expandFractions) {
      result = expandFractions(result);
    }
    if (this.options.expandDecades) {
      result = expandDecades(result);
    }
    if (this.options.expandPhoneNumbers) {
      result = expandPhoneNumbers(result);
    }
    if (this.options.expandRanges) {
      result = expandRanges(result);
    }
    if (this.options.expandModelNames) {
      result = expandModelNames(result);
    }
    if (this.options.replaceNumbers) {
      result = replaceNumbers(result, this.options.replaceFloats);
    }
    if (this.options.removePunctuation) {
      result = removePunctuation(result);
    }
    if (this.options.lowercase) {
      result = toLowercase(result);
    }
    if (this.options.removeExtraWhitespace) {
      result = removeExtraWhitespace(result);
    }
    return result;
  }
}

export function ensurePunctuation(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  return /[.!?,;:]$/.test(trimmed) ? trimmed : `${trimmed},`;
}

function isSentenceBoundary(text: string, index: number): boolean {
  const char = text[index];
  if (char !== "." && char !== "!" && char !== "?") {
    return false;
  }
  if (char === ".") {
    if (index > 0 && index < text.length - 1 && /\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? "")) {
      return false;
    }
    let tokenStart = index;
    while (tokenStart > 0 && /[A-Za-z]/.test(text[tokenStart - 1] ?? "")) {
      tokenStart -= 1;
    }
    const token = text.slice(tokenStart, index).toLowerCase();
    if (NON_BOUNDARY_ABBREVIATIONS.has(token)) {
      return false;
    }
    if ((token === "a" || token === "p") && text[index + 1]?.toLowerCase() === "m") {
      return false;
    }
    if (token === "m" && /\b[ap]\.m$/i.test(text.slice(Math.max(0, index - 4), index))) {
      const nextText = text.slice(index + 1).trim();
      return !nextText || /^[A-Z]/.test(nextText);
    }
  }
  const nextChar = text[index + 1];
  return nextChar === undefined || /\s/.test(nextChar);
}

export function chunkText(text: string, maxLen = 400): string[] {
  if (!Number.isInteger(maxLen) || maxLen < 2) {
    throw new Error("maxLen must be an integer greater than or equal to 2");
  }
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isSentenceBoundary(text, index)) {
      sentences.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) {
    sentences.push(text.slice(start));
  }
  const chunks: string[] = [];

  const appendBounded = (value: string): void => {
    let remaining = value.trim();
    while (remaining) {
      const punctuated = ensurePunctuation(remaining);
      if (punctuated.length <= maxLen) {
        chunks.push(punctuated);
        return;
      }

      // Reserve one code unit for punctuation, then prefer the last whitespace
      // boundary. Avoid cutting between UTF-16 surrogate pairs as a fallback.
      const contentLimit = maxLen - 1;
      let end = Math.min(contentLimit, remaining.length);
      if (
        end < remaining.length &&
        /[\uD800-\uDBFF]/.test(remaining[end - 1] ?? "") &&
        /[\uDC00-\uDFFF]/.test(remaining[end] ?? "")
      ) {
        end -= 1;
      }
      let boundary = end;
      while (boundary > 0 && !/\s/.test(remaining[boundary] ?? "")) {
        boundary -= 1;
      }
      if (boundary === 0) {
        boundary = end;
      }

      const part = remaining.slice(0, boundary).trim();
      if (!part) {
        throw new Error("unable to split text within maxLen");
      }
      chunks.push(ensurePunctuation(part));
      remaining = remaining.slice(boundary).trim();
    }
  };

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      continue;
    }
    appendBounded(trimmed);
  }
  return chunks;
}

export function preprocessForTts(text: string): string {
  return new TextPreprocessor({ removePunctuation: false }).process(text);
}
