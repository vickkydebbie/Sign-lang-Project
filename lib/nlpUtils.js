/**
 * nlpUtils.js  —  Sprint 2
 * Lightweight deterministic NLP pipeline for ASL tokenization.
 * New in Sprint 2:
 *  - PHRASE_MAP: multi-word phrases mapped directly to ASL gloss sequences
 *  - TIME_WORDS: time expressions bubble to the front of output (ASL grammar)
 *  - Expanded LEMMA_RULES: irregular verbs (went→go, ate→eat, saw→see, etc.)
 *  - Broader ASL_STOP_WORDS list
 */

// ---------------------------------------------------------------------------
// 1. ASL Stop Words — words with no ASL sign equivalent
// ---------------------------------------------------------------------------
const ASL_STOP_WORDS = new Set([
  'a', 'an', 'the',
  'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did',
  'have', 'has', 'had',
  'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'can', 'could',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'as',
  'and', 'or', 'but', 'if', 'so', 'yet', 'nor',
  'it', 'its', 'this', 'that', 'these', 'those',
  'very', 'just', 'too', 'also',
  'some', 'any', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'such', 'than', 'into', 'through', 'between', 'own',
  'my', 'your', 'his', 'her', 'our', 'their', 'its',
  'i', 'we', 'they', 'he', 'she', 'me', 'him', 'us', 'them',
]);

// ---------------------------------------------------------------------------
// 2. Phrase Map — checked BEFORE word-level tokenization.
//    Keys: lowercase normalized phrases. Values: ASL gloss token arrays.
//    Longer phrases are checked first (sorted by word count desc).
// ---------------------------------------------------------------------------
const PHRASE_MAP = new Map([
  ['what is your name',   ['NAME', 'YOU', 'WHAT']],
  ['nice to meet you',    ['NICE', 'MEET', 'YOU']],
  ['how are you',         ['HOW', 'YOU']],
  ['i love you',          ['LOVE', 'YOU']],
  ['see you later',       ['SEE', 'YOU', 'LATER']],
  ['what time is it',     ['TIME', 'WHAT']],
  ['i dont know',         ['KNOW', 'NOT']],
  ['i do not know',       ['KNOW', 'NOT']],
  ['i need help',         ['HELP', 'NEED']],
  ['good morning',        ['GOOD', 'MORNING']],
  ['good night',          ['GOOD', 'NIGHT']],
  ['good afternoon',      ['GOOD', 'AFTERNOON']],
  ['thank you',           ['THANK']],
  ['excuse me',           ['SORRY']],
  ['i am sorry',          ['SORRY']],
  ['i am fine',           ['FINE', 'ME']],
  ['im sorry',            ['SORRY']],
  ['im fine',             ['FINE', 'ME']],
  ['im happy',            ['HAPPY', 'ME']],
  ['im sad',              ['SAD', 'ME']],
]);

// Sort by phrase length descending so longer phrases match first
const SORTED_PHRASES = [...PHRASE_MAP.entries()].sort(
  (a, b) => b[0].split(' ').length - a[0].split(' ').length
);

// ---------------------------------------------------------------------------
// 3. Time Words — these float to the FRONT of the ASL gloss output
//    (ASL grammar: temporal markers appear at sentence start)
// ---------------------------------------------------------------------------
const TIME_WORDS = new Set([
  'YESTERDAY', 'TODAY', 'TOMORROW', 'NOW', 'SOON', 'LATER',
  'MORNING', 'AFTERNOON', 'NIGHT', 'TONIGHT',
  'RECENTLY', 'BEFORE', 'AFTER', 'NEXT', 'LAST', 'ALWAYS', 'NEVER',
]);

// ---------------------------------------------------------------------------
// 4. Lemmatization rules — deterministic suffix stripping (longest first)
// ---------------------------------------------------------------------------
const LEMMA_RULES = [
  // Irregular verbs — past tense (checked first, exact match)
  { type: 'exact', from: 'went',      to: 'go'     },
  { type: 'exact', from: 'ate',       to: 'eat'    },
  { type: 'exact', from: 'drank',     to: 'drink'  },
  { type: 'exact', from: 'saw',       to: 'see'    },
  { type: 'exact', from: 'came',      to: 'come'   },
  { type: 'exact', from: 'knew',      to: 'know'   },
  { type: 'exact', from: 'slept',     to: 'sleep'  },
  { type: 'exact', from: 'felt',      to: 'feel'   },
  { type: 'exact', from: 'told',      to: 'tell'   },
  { type: 'exact', from: 'found',     to: 'find'   },
  { type: 'exact', from: 'gave',      to: 'give'   },
  { type: 'exact', from: 'took',      to: 'take'   },
  { type: 'exact', from: 'bought',    to: 'buy'    },
  { type: 'exact', from: 'met',       to: 'meet'   },
  { type: 'exact', from: 'left',      to: 'leave'  },
  { type: 'exact', from: 'ran',       to: 'run'    },
  { type: 'exact', from: 'got',       to: 'get'    },
  { type: 'exact', from: 'said',      to: 'say'    },
  { type: 'exact', from: 'made',      to: 'make'   },
  // Pre-existing irregular forms
  { type: 'exact', from: 'talking',   to: 'talk'   },
  { type: 'exact', from: 'saying',    to: 'say'    },
  { type: 'exact', from: 'going',     to: 'go'     },
  { type: 'exact', from: 'doing',     to: 'do'     },
  { type: 'exact', from: 'having',    to: 'have'   },
  { type: 'exact', from: 'making',    to: 'make'   },
  { type: 'exact', from: 'running',   to: 'run'    },
  { type: 'exact', from: 'seeing',    to: 'see'    },
  { type: 'exact', from: 'coming',    to: 'come'   },
  { type: 'exact', from: 'getting',   to: 'get'    },
  { type: 'exact', from: 'knowing',   to: 'know'   },
  { type: 'exact', from: 'thinking',  to: 'think'  },
  { type: 'exact', from: 'helping',   to: 'help'   },
  { type: 'exact', from: 'needing',   to: 'need'   },
  { type: 'exact', from: 'wanting',   to: 'want'   },
  { type: 'exact', from: 'loves',     to: 'love'   },
  { type: 'exact', from: 'loved',     to: 'love'   },
  { type: 'exact', from: 'loving',    to: 'love'   },
  { type: 'exact', from: 'thanks',    to: 'thank'  },
  { type: 'exact', from: 'thanked',   to: 'thank'  },
  { type: 'exact', from: 'thanking',  to: 'thank'  },
  // Suffix rules (longest first)
  { type: 'suffix', from: 'ying',     to: 'y'      },
  { type: 'suffix', from: 'ies',      to: 'y'      },
  { type: 'suffix', from: 'ied',      to: 'y'      },
  { type: 'suffix', from: 'ving',     to: 've'     },
  { type: 'suffix', from: 'ing',      to: ''       },
  { type: 'suffix', from: 'tion',     to: 't'      },
  { type: 'suffix', from: 'ness',     to: ''       },
  { type: 'suffix', from: 'ment',     to: ''       },
  { type: 'suffix', from: 'ful',      to: ''       },
  { type: 'suffix', from: 'less',     to: ''       },
  { type: 'suffix', from: 'ly',       to: ''       },
  { type: 'suffix', from: 'able',     to: ''       },
  { type: 'suffix', from: 'ible',     to: ''       },
  { type: 'suffix', from: 'ive',      to: ''       },
  { type: 'suffix', from: 'ous',      to: ''       },
  { type: 'suffix', from: 'al',       to: ''       },
  { type: 'suffix', from: 'ed',       to: ''       },
  { type: 'suffix', from: 's',        to: ''       },
];

const MIN_LEMMA_LENGTH = 2;

function applyLemmaRules(word) {
  for (const rule of LEMMA_RULES) {
    if (rule.type === 'exact') {
      if (word === rule.from) return rule.to;
      continue;
    }
    if (word.endsWith(rule.from)) {
      const stem = word.slice(0, word.length - rule.from.length) + rule.to;
      if (stem.length >= MIN_LEMMA_LENGTH) return stem;
    }
  }
  return word;
}

function lemmatize(word) {
  const pass1 = applyLemmaRules(word);
  if (pass1 !== word) return applyLemmaRules(pass1);
  return word;
}

// ---------------------------------------------------------------------------
// 5. Text normalization
// ---------------------------------------------------------------------------
function normalizeText(raw) {
  return raw
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// 6. Phrase scan — replaces matched sub-phrases with gloss tokens
//    Returns { tokens: string[], consumed: Set<number> }
// ---------------------------------------------------------------------------
function scanPhrases(words) {
  const glossTokens = [];  // { gloss: string, fromPhrase: boolean, wordIndex: number }
  const consumed = new Set();

  for (const [phrase, gloss] of SORTED_PHRASES) {
    const phraseWords = phrase.split(' ');
    const len = phraseWords.length;
    for (let i = 0; i <= words.length - len; i++) {
      if (consumed.has(i)) continue;
      const window = words.slice(i, i + len).join(' ');
      if (window === phrase) {
        for (let j = i; j < i + len; j++) consumed.add(j);
        gloss.forEach((g, idx) =>
          glossTokens.push({ gloss: g, index: i + idx / 10 })
        );
        break;
      }
    }
  }
  return { glossTokens, consumed };
}

// ---------------------------------------------------------------------------
// 7. Main tokenizer
// ---------------------------------------------------------------------------

/**
 * Process raw input and return an array of ASL tokens.
 *
 * @param {string} rawText
 * @param {Set<string>} dictKeys  — uppercase keys from dictionary.json
 * @returns {{ token: string, type: 'word'|'letter', source: string }[]}
 */
export function tokenize(rawText, dictKeys) {
  if (!rawText || !rawText.trim()) return [];

  const normalized = normalizeText(rawText);
  const words = normalized.split(' ').filter(Boolean);

  // --- Phase 1: phrase scanning ---
  const { glossTokens, consumed } = scanPhrases(words);

  // --- Phase 2: word-by-word for non-consumed words ---
  const wordTokens = [];
  for (let i = 0; i < words.length; i++) {
    if (consumed.has(i)) continue;
    const word = words[i];
    if (ASL_STOP_WORDS.has(word)) continue;
    const lemma = lemmatize(word);
    const upperLemma = lemma.toUpperCase();
    const upperWord  = word.toUpperCase();

    if (dictKeys.has(upperLemma)) {
      wordTokens.push({ gloss: upperLemma, index: i, source: word });
    } else if (dictKeys.has(upperWord)) {
      wordTokens.push({ gloss: upperWord, index: i, source: word });
    } else {
      // Fingerspelling fallback
      for (let ci = 0; ci < upperLemma.length; ci++) {
        const letter = upperLemma[ci];
        if (/[A-Z]/.test(letter)) {
          wordTokens.push({ gloss: letter, index: i + ci / 100, source: word });
        }
      }
    }
  }

  // --- Phase 3: merge and sort by original position ---
  const allGloss = [...glossTokens, ...wordTokens].sort((a, b) => a.index - b.index);

  // --- Phase 4: time-word fronting (ASL grammar) ---
  const timeTokens  = allGloss.filter(t => TIME_WORDS.has(t.gloss));
  const otherTokens = allGloss.filter(t => !TIME_WORDS.has(t.gloss));
  const ordered = [...timeTokens, ...otherTokens];

  // --- Phase 5: shape final token objects ---
  return ordered.map(({ gloss, source }) => ({
    token:  gloss,
    type:   gloss.length === 1 ? 'letter' : 'word',
    source: source ?? gloss.toLowerCase(),
  }));
}

// ---------------------------------------------------------------------------
// 8. Dictionary loaders
// ---------------------------------------------------------------------------
export async function loadDictionaryKeys() {
  const res  = await fetch('/dictionary.json');
  const data = await res.json();
  return new Set(
    Object.keys(data)
      .filter(k => !k.startsWith('_'))
      .map(k => k.toUpperCase())
  );
}

export async function loadDictionary() {
  const res  = await fetch('/dictionary.json');
  const data = await res.json();
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith('_')) result[key.toUpperCase()] = value;
  }
  return result;
}
