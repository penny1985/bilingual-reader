import { Converter, Locale } from './vendor/opencc-js/cn2t.js';

let taiwanConverter;
let traditionalConverter;
let simplifiedCharacters;

function initializeConverters() {
  if (taiwanConverter) return;
  taiwanConverter = Converter({ from: 'cn', to: 'twp' });
  traditionalConverter = Converter({ from: 't', to: 'twp' });
  // Detection only; actual conversion always uses OpenCC phrase dictionaries.
  // A character also found in a Traditional dictionary phrase (里, 后, 干,
  // etc.) cannot by itself establish that a clause is Simplified Chinese.
  const pairs = Locale.from.cn.flatMap((group) => group.flatMap((dictionary) =>
    typeof dictionary === 'string' ? dictionary.split('|').map((entry) => entry.split(' ')) : dictionary));
  const traditionalCharacters = new Set(pairs.flatMap(([, replacement]) => [...replacement]));
  simplifiedCharacters = new Set(pairs.filter(([source]) => [...source].length === 1 && !traditionalCharacters.has(source)).map(([source]) => source));
}

function convertProse(prose) {
  // The Simplified converter's ambiguity rules assume Simplified input.
  // Reapplying them to already-Traditional clauses can turn 一出來 into
  // 一齣來 or 萬里 into 萬裡, so use only Taiwan phrase/variant rules there.
  return prose.replace(/[^，。！？；：、\r\n]+/gu, (clause) => {
    const converter = [...clause].some((character) => simplifiedCharacters.has(character)) ? taiwanConverter : traditionalConverter;
    // In Taiwan, 智能 is also the established word for human intellectual
    // ability. OpenCC's broad 智能 → 智慧 rule must not change these terms.
    // Keep AI references (人工智能測驗, for example) on the normal AI path.
    const cognitiveTerms = /(?<!人工)智能(?:障[碍礙]|不足|[测測][验驗]|商[数數])/gu;
    let converted = '';
    let cursor = 0;
    for (const match of clause.matchAll(cognitiveTerms)) {
      converted += converter(clause.slice(cursor, match.index));
      converted += '智能' + converter(match[0].slice(2));
      cursor = match.index + match[0].length;
    }
    converted += converter(clause.slice(cursor));
    // Never replace 質量 globally: scientific mass must remain 質量.
    return converted
      // NASA aliases need a Taiwan proper-name correction in addition to
      // character conversion. Scope this to the US agency: 航天 in Chinese
      // agency/company names and other proper nouns must stay untouched.
      .replace(/美國(?:國家)?(?:航空(?:暨|與|和|及)?(?:航天|太空)(?:管理)?(?:局|總署)|(?:航太|航天|太空)(?:管理)?(?:局|總署))/gu, '美國國家航空暨太空總署')
      .replace(/(軟體|服務|翻譯)質量/g, '$1品質')
      .replace(/賬號/g, '帳號')
      // Correct an upstream Taiwan dictionary target containing Simplified 别.
      .replace(/類别範本/g, '類別範本');
  });
}

// Keep protected spans in the original string instead of replacing them with
// sentinel tokens: translated text can legitimately contain any such token.
function protectedSpans(text) {
  const spans = [];
  const protect = (start, end) => {
    if (end > start) spans.push([start, end]);
  };
  const containingSpan = (index) => spans.find(([start, end]) => start <= index && index < end);

  // CommonMark fences, including an unclosed fence through the end of input.
  const fences = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/gm;
  let match;
  while ((match = fences.exec(text))) {
    const marker = match[1][0];
    if (marker === '`' && match[0].slice(match[0].indexOf(match[1]) + match[1].length).includes('`')) continue;
    const closing = new RegExp('^ {0,3}' + marker + '{' + match[1].length + ',}[\\t ]*(?:\\r?\\n|$)', 'gm');
    closing.lastIndex = fences.lastIndex;
    const end = closing.exec(text);
    const endIndex = end ? closing.lastIndex : text.length;
    protect(match.index, endIndex);
    fences.lastIndex = endIndex;
  }

  // Inline backticks must close with a run of exactly the same length.
  const backticks = /`+/g;
  while ((match = backticks.exec(text))) {
    const existing = containingSpan(match.index);
    if (existing) { backticks.lastIndex = existing[1]; continue; }
    const delimiter = match[0];
    let close = text.indexOf(delimiter, backticks.lastIndex);
    while (close !== -1 && (text[close - 1] === '`' || text[close + delimiter.length] === '`' || containingSpan(close))) {
      close = text.indexOf(delimiter, close + delimiter.length);
    }
    if (close !== -1) {
      protect(match.index, close + delimiter.length);
      backticks.lastIndex = close + delimiter.length;
    }
  }

  function protectDestination(start) {
    while (/[\t \r\n]/.test(text[start] || '') && start < text.length) start += 1;
    if (text[start] === '<') {
      for (let index = start + 1; index < text.length; index += 1) {
        if (text[index] === '\\') { index += 1; continue; }
        if (text[index] === '>') { protect(start + 1, index); return; }
        if (text[index] === '\n' || text[index] === '\r') return;
      }
      return;
    }
    let depth = 0;
    let index = start;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (character === '\\') { index += 1; continue; }
      if (/\s/.test(character)) break;
      if (character === '(') depth += 1;
      if (character === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    if (depth === 0) protect(start, index);
  }

  // Labels remain prose, but link destinations (also relative ones) stay exact.
  const inlineLinks = /\]\(/g;
  while ((match = inlineLinks.exec(text))) {
    if (!containingSpan(match.index)) protectDestination(inlineLinks.lastIndex);
  }
  const referenceLinks = /^ {0,3}\[[^\]\r\n]+\]:[\t ]*/gm;
  while ((match = referenceLinks.exec(text))) {
    if (!containingSpan(match.index)) protectDestination(referenceLinks.lastIndex);
  }

  // Chinese characters are valid in URL paths and queries. Chinese sentence
  // punctuation terminates a bare URL; a Markdown destination can contain it.
  const urls = /(?:https?:\/\/|ftp:\/\/|mailto:)[^\s<>"'`，。！？；：、「」『』【】《》]+/giu;
  while ((match = urls.exec(text))) {
    let end = urls.lastIndex;
    while (end > match.index && /[.,;:!?]/.test(text[end - 1])) end -= 1;
    for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}'], ['（', '）']]) {
      while (text[end - 1] === closing) {
        const token = text.slice(match.index, end);
        const opens = [...token].filter((character) => character === opening).length;
        const closes = [...token].filter((character) => character === closing).length;
        if (closes <= opens) break;
        end -= 1;
      }
    }
    protect(match.index, end);
  }
  const emails = /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}/gu;
  while ((match = emails.exec(text))) protect(match.index, emails.lastIndex);

  // Preserve common filesystem paths, filenames and explicit code identifiers.
  const absolutePaths = /(?<![\p{L}\p{N}_])(?:[A-Za-z]:[\\/]|(?:~|\.\.?)\/|\/)[^\s<>"'`，。！？；：、（）「」『』【】《》]*[\p{L}\p{N}_~%]/gu;
  while ((match = absolutePaths.exec(text))) protect(match.index, absolutePaths.lastIndex);
  const relativePaths = /(?:[\p{L}\p{N}_~%+@.-]+[\\/])+[\p{L}\p{N}_~%+@.()[\]\\-]+/gu;
  while ((match = relativePaths.exec(text))) {
    // Unmarked Chinese slash lists such as 輸入/輸出 are ordinary prose.
    // An ASCII path segment or filename extension makes the literal explicit.
    if (/[A-Za-z0-9._~%@+-]/.test(match[0])) protect(match.index, relativePaths.lastIndex);
  }
  const filenames = /[\p{L}\p{N}_-]+\.[A-Za-z][A-Za-z0-9]{0,9}(?![\p{L}\p{N}_])/gu;
  while ((match = filenames.exec(text))) protect(match.index, filenames.lastIndex);
  const identifiers = /[$\p{L}_][$\p{L}\p{N}_]*(?:\.[$\p{L}_][$\p{L}\p{N}_]*)*/gu;
  while ((match = identifiers.exec(text))) {
    if (/[$_.]/.test(match[0])) protect(match.index, identifiers.lastIndex);
  }

  // These are already-correct Taiwan terms. Upstream's shorter dictionary
  // entries otherwise expand them again (e.g. 運算子 → 運運算元).
  const taiwanTerms = /數據機|運算子|真實模式|腦梗塞|史他汀/gu;
  while ((match = taiwanTerms.exec(text))) protect(match.index, taiwanTerms.lastIndex);

  spans.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push(span.slice());
  }
  return merged;
}

/**
 * Normalize translated prose to Taiwan Traditional Chinese, fully offline.
 * This changes spelling, regional terms and known proper-name aliases,
 * not a sentence's meaning.
 * URLs, code and technical literals are intentionally kept byte-for-byte.
 */
export function toTaiwanTraditional(text) {
  if (typeof text !== 'string') throw new TypeError('Translated text must be a string.');
  if (!text || !/\p{Script=Han}/u.test(text)) return text;
  initializeConverters();
  const parts = [];
  let cursor = 0;
  for (const [start, end] of protectedSpans(text)) {
    parts.push(convertProse(text.slice(cursor, start)), text.slice(start, end));
    cursor = end;
  }
  parts.push(convertProse(text.slice(cursor)));
  return parts.join('');
}
