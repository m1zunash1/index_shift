const DICT_LABELS = {
  kobuta: '仔豚辞書',
  general: '一般語辞書',
  item: 'イラスト辞書',
  english: '英語辞書',
  roma: 'ローマ字辞書',
};

const CHUNK_COLORS = [
  { name: 'R', className: 'chunk-r' },
  { name: 'G', className: 'chunk-g' },
  { name: 'B', className: 'chunk-b' },
  { name: 'Y', className: 'chunk-y' },
  { name: 'P', className: 'chunk-p' },
  { name: 'Gr', className: 'chunk-gray' },
];

const state = {
  dictionaries: {},
  cache: {
    merged: new Map(),
  },
  lastSearch: null,
};

const sourceInputEl = document.getElementById('sourceInput');
const inputMetaEl = document.getElementById('inputMeta');
const shiftSpecEl = document.getElementById('shiftSpec');
const loopAllowedEl = document.getElementById('loopAllowed');
const omitRepeatPairsEl = document.getElementById('omitRepeatPairs');
const maxResultsEl = document.getElementById('maxResults');
const sortOrderEl = document.getElementById('sortOrder');
const searchBtnEl = document.getElementById('searchBtn');
const errorBoxEl = document.getElementById('errorBox');
const summaryEl = document.getElementById('summary');
const resultsEl = document.getElementById('results');

function normalizeWord(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function normalizeSource(value) {
  return String(value || '').normalize('NFKC').toLowerCase();
}

function splitChars(value) {
  return Array.from(value);
}

function isRepeatedWord(word) {
  const chars = splitChars(word);
  if (chars.length < 2 || chars.length % 2 !== 0) {
    return false;
  }
  const half = chars.length / 2;
  for (let index = 0; index < half; index += 1) {
    if (chars[index] !== chars[index + half]) {
      return false;
    }
  }
  return true;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseDictionary(text) {
  const words = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const word = normalizeWord(raw);
    if (!word || seen.has(word)) {
      continue;
    }
    seen.add(word);
    words.push(word);
  }
  return words;
}

function makeTrieNode() {
  return {
    children: new Map(),
    terminalEntries: [],
  };
}

function addWordToTrie(root, word, entry) {
  let node = root;
  for (const ch of splitChars(word)) {
    if (!node.children.has(ch)) {
      node.children.set(ch, makeTrieNode());
    }
    node = node.children.get(ch);
  }
  node.terminalEntries.push(entry);
}

function loadDictionaries() {
  if (typeof EMBEDDED_DICT_TEXT !== 'object' || EMBEDDED_DICT_TEXT === null) {
    throw new Error('dict-data.js を読み込めませんでした。');
  }

  for (const [key, label] of Object.entries(DICT_LABELS)) {
    const text = EMBEDDED_DICT_TEXT[key];
    if (typeof text !== 'string') {
      throw new Error(`${label} の辞書データが見つかりません。`);
    }
    state.dictionaries[key] = {
      label,
      words: parseDictionary(text),
    };
  }
}

function selectedDictIds() {
  return Array.from(document.querySelectorAll('input[name="targetDict"]:checked')).map((el) => el.value);
}

function dictCacheKey(dictIds) {
  return [...new Set(dictIds)].sort().join('|');
}

function mergeDictionaries(dictIds) {
  const key = dictCacheKey(dictIds);
  if (state.cache.merged.has(key)) {
    return state.cache.merged.get(key);
  }

  const wordMap = new Map();
  for (const id of dictIds) {
    const dict = state.dictionaries[id];
    if (!dict) {
      continue;
    }
    for (const word of dict.words) {
      if (!wordMap.has(word)) {
        wordMap.set(word, new Set());
      }
      wordMap.get(word).add(id);
    }
  }

  const entries = Array.from(wordMap.entries()).map(([word, ids]) => ({
    word,
    dictIds: [...ids].sort(),
    length: splitChars(word).length,
  }));

  const trie = makeTrieNode();
  for (const entry of entries) {
    addWordToTrie(trie, entry.word, entry);
  }

  const merged = { entries, trie };
  state.cache.merged.set(key, merged);
  return merged;
}

function parseChunks(rawInput) {
  const chunks = normalizeSource(rawInput)
    .split(/[\/\r\n]+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  const tokens = [];
  chunks.forEach((chunk, chunkIndex) => {
    splitChars(chunk).forEach((char, indexInChunk) => {
      tokens.push({
        char,
        chunkIndex,
        indexInChunk,
        absoluteIndex: tokens.length,
      });
    });
  });

  return { chunks, tokens };
}

function parseShiftSpec(value, defaultMax) {
  const text = String(value || '').normalize('NFKC').trim();
  if (!text) {
    return Array.from({ length: Math.max(0, defaultMax - 1) }, (_item, index) => index + 1);
  }

  const shifts = new Set();
  for (const part of text.split(/[,\s、]+/)) {
    if (!part) {
      continue;
    }
    const rangeMatch = part.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      const step = start <= end ? 1 : -1;
      for (let current = start; current !== end + step; current += step) {
        shifts.add(current);
      }
      continue;
    }
    if (!/^-?\d+$/.test(part)) {
      throw new Error('シフト数は 1-3 や 1,3,7 のように指定してください。');
    }
    shifts.add(Number(part));
  }

  const sorted = [...shifts].sort((a, b) => a - b);
  if (sorted.length === 0) {
    throw new Error('シフト数を1つ以上指定してください。');
  }
  if (sorted.some((shift) => shift === 0)) {
    throw new Error('シフト数 0 は対象外です。');
  }
  return sorted;
}

function buildShiftModel(tokens, shift, loopAllowed) {
  const tokenCount = tokens.length;
  const keyStates = new Map();

  tokens.forEach((token, index) => {
    const destinationIndex = index + shift;
    if (!loopAllowed && (destinationIndex < 0 || destinationIndex >= tokenCount)) {
      return;
    }

    const wrappedIndex = ((destinationIndex % tokenCount) + tokenCount) % tokenCount;
    const destination = tokens[wrappedIndex];
    const key = `${token.char}\u0001${token.chunkIndex}`;
    let stateForKey = keyStates.get(key);
    if (!stateForKey) {
      stateForKey = {
        sourceChar: token.char,
        chunkIndex: token.chunkIndex,
        destChar: destination.char,
        ambiguous: false,
        examples: [],
      };
      keyStates.set(key, stateForKey);
    } else if (stateForKey.destChar !== destination.char) {
      stateForKey.ambiguous = true;
    }

    if (stateForKey.examples.length < 4) {
      stateForKey.examples.push({
        fromIndex: index,
        toIndex: wrappedIndex,
        source: token,
        destination,
      });
    }
  });

  const transitionsBySource = new Map();
  const validStates = [];
  for (const item of keyStates.values()) {
    if (item.ambiguous) {
      continue;
    }
    validStates.push(item);
    if (!transitionsBySource.has(item.sourceChar)) {
      transitionsBySource.set(item.sourceChar, []);
    }
    transitionsBySource.get(item.sourceChar).push(item);
  }

  for (const list of transitionsBySource.values()) {
    list.sort((a, b) => {
      const chunkDiff = a.chunkIndex - b.chunkIndex;
      if (chunkDiff !== 0) {
        return chunkDiff;
      }
      return a.destChar.localeCompare(b.destChar, 'ja');
    });
  }

  return { shift, transitionsBySource, validStates };
}

function findShiftPairs(settings) {
  const merged = mergeDictionaries(settings.dictIds);
  const results = [];
  const resultKeys = new Set();
  let truncated = false;

  for (const shift of settings.shifts) {
    if (truncated) {
      break;
    }

    const model = buildShiftModel(settings.tokens, shift, settings.loopAllowed);
    if (model.validStates.length === 0) {
      continue;
    }

    for (const sourceEntry of merged.entries) {
      if (truncated) {
        break;
      }
      const sourceChars = splitChars(sourceEntry.word);
      const path = [];

      function dfs(charIndex, trieNode) {
        if (truncated) {
          return;
        }
        if (charIndex === sourceChars.length) {
          for (const targetEntry of trieNode.terminalEntries) {
            if (settings.omitRepeatPairs && isRepeatedWord(sourceEntry.word) && isRepeatedWord(targetEntry.word)) {
              continue;
            }
            const key = `${shift}\u0001${sourceEntry.word}\u0001${targetEntry.word}\u0001${path.map((item) => item.chunkIndex).join(',')}`;
            if (resultKeys.has(key)) {
              continue;
            }
            resultKeys.add(key);
            results.push({
              shift,
              source: sourceEntry,
              target: targetEntry,
              path: [...path],
              length: sourceEntry.length,
            });
            if (results.length >= settings.maxResults) {
              truncated = true;
              return;
            }
          }
          return;
        }

        const transitions = model.transitionsBySource.get(sourceChars[charIndex]);
        if (!transitions) {
          return;
        }

        for (const transition of transitions) {
          const nextNode = trieNode.children.get(transition.destChar);
          if (!nextNode) {
            continue;
          }
          path.push(transition);
          dfs(charIndex + 1, nextNode);
          path.pop();
          if (truncated) {
            return;
          }
        }
      }

      dfs(0, merged.trie);
    }
  }

  return { results, truncated };
}

function validateForm() {
  const parsed = parseChunks(sourceInputEl.value);
  const dictIds = selectedDictIds();
  const maxResults = Number(maxResultsEl.value);

  if (parsed.tokens.length === 0) {
    throw new Error('入力欄に文字列を入れてください。');
  }
  if (dictIds.length === 0) {
    throw new Error('辞書を1つ以上選んでください。');
  }
  if (!Number.isInteger(maxResults) || maxResults < 1) {
    throw new Error('最大表示件数は1以上の整数で指定してください。');
  }

  const shifts = parseShiftSpec(shiftSpecEl.value, parsed.tokens.length);
  if (shifts.length === 0) {
    throw new Error('文字列が1文字だけの場合、デフォルトで調べるシフト数がありません。');
  }
  return {
    ...parsed,
    shifts,
    dictIds,
    maxResults,
    loopAllowed: loopAllowedEl.checked,
    omitRepeatPairs: omitRepeatPairsEl.checked,
  };
}

function sortRows(rows, order) {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    if (order === 'shift') {
      const shiftDiff = a.shift - b.shift;
      if (shiftDiff !== 0) {
        return shiftDiff;
      }
    }

    const lenDiff = a.length - b.length;
    if (lenDiff !== 0) {
      return order === 'long' ? -lenDiff : lenDiff;
    }

    const sourceCmp = a.source.word.localeCompare(b.source.word, 'ja');
    if (sourceCmp !== 0) {
      return sourceCmp;
    }
    const targetCmp = a.target.word.localeCompare(b.target.word, 'ja');
    if (targetCmp !== 0) {
      return targetCmp;
    }
    return a.shift - b.shift;
  });
  return sorted;
}

function chunkClass(chunkIndex) {
  return CHUNK_COLORS[chunkIndex]?.className || CHUNK_COLORS[CHUNK_COLORS.length - 1].className;
}

function chunkName(chunkIndex) {
  return `チャンク${chunkIndex + 1}`;
}

function renderDictionaryTags(entry) {
  return entry.dictIds.map((id) => `<span class="dict-tag">${escapeHtml(DICT_LABELS[id])}</span>`).join('');
}

function renderTokenizedWord(word, path, showDestination) {
  const chars = splitChars(word);
  return chars
    .map((char, index) => {
      const transition = path[index];
      const className = chunkClass(transition.chunkIndex);
      const label = `${chunkName(transition.chunkIndex)} / ${escapeHtml(transition.sourceChar)}→${escapeHtml(transition.destChar)}`;
      return `
        <span class="token ${className}" title="${label}">
          <span class="token-char">${escapeHtml(char)}</span>
          <span class="token-note">${transition.chunkIndex + 1}</span>
          ${showDestination ? `<span class="token-arrow">${escapeHtml(transition.sourceChar)}→${escapeHtml(transition.destChar)}</span>` : ''}
        </span>
      `;
    })
    .join('');
}

function renderChunkPreview(chunks) {
  return chunks
    .map((chunk, index) => `
      <div class="chunk-preview ${chunkClass(index)}">
        <div class="chunk-preview-head">${chunkName(index)}</div>
        <div class="chunk-preview-body">${splitChars(chunk).map((char) => `<span>${escapeHtml(char)}</span>`).join('')}</div>
      </div>
    `)
    .join('');
}

function renderPathSummary(path) {
  const items = path.map((transition) => {
    const className = chunkClass(transition.chunkIndex);
    return `<span class="map-chip ${className}">${escapeHtml(transition.sourceChar)}<small>${transition.chunkIndex + 1}</small>→${escapeHtml(transition.destChar)}</span>`;
  });
  return items.join('');
}

function renderResults(rows, truncated, settings) {
  if (rows.length === 0) {
    resultsEl.innerHTML = '<div class="empty">ヒットなし</div>';
    return;
  }

  resultsEl.innerHTML = rows
    .map((row, index) => `
      <article class="result-item">
        <div class="result-head">
          <div class="result-title">${index + 1}. ${escapeHtml(row.source.word)} → ${escapeHtml(row.target.word)}</div>
          <div class="result-meta">
            <span class="pattern-badge">${row.shift}ずらし</span>
            <span class="pattern-badge">${row.length}文字</span>
          </div>
        </div>
        <div class="word-grid">
          <div class="word-box">
            <div class="word-label">変換前</div>
            <div class="preview-line">${renderTokenizedWord(row.source.word, row.path, false)}</div>
            <div class="result-meta">${renderDictionaryTags(row.source)}</div>
          </div>
          <div class="word-box">
            <div class="word-label">変換後</div>
            <div class="preview-line">${renderTokenizedWord(row.target.word, row.path, true)}</div>
            <div class="result-meta">${renderDictionaryTags(row.target)}</div>
          </div>
        </div>
      </article>
    `)
    .join('');

  if (truncated) {
    resultsEl.insertAdjacentHTML('beforeend', '<div class="more-note">表示件数の上限に達したため、結果を途中で打ち切っています。</div>');
  }
}

function updateInputMeta() {
  const { chunks, tokens } = parseChunks(sourceInputEl.value);
  if (tokens.length === 0) {
    inputMetaEl.textContent = '未入力';
    inputMetaEl.className = 'pill muted';
    return;
  }
  inputMetaEl.textContent = `${tokens.length}文字 / ${chunks.length}チャンク`;
  inputMetaEl.className = 'pill';
}

function rerenderLastResults() {
  if (!state.lastSearch) {
    return;
  }
  const sortedRows = sortRows(state.lastSearch.rows, sortOrderEl.value);
  renderResults(sortedRows, state.lastSearch.truncated, state.lastSearch.settings);
}

function runSearch() {
  errorBoxEl.textContent = '';
  resultsEl.innerHTML = '';

  try {
    const settings = validateForm();
    summaryEl.textContent = '検索中...';
    resultsEl.innerHTML = `<div class="chunk-preview-grid">${renderChunkPreview(settings.chunks)}</div>`;

    window.setTimeout(() => {
      try {
        const startedAt = performance.now();
        const { results, truncated } = findShiftPairs(settings);
        const elapsed = Math.round(performance.now() - startedAt);
        state.lastSearch = { rows: results, truncated, settings };
        summaryEl.textContent = `ヒット数: ${results.length} / ${elapsed}ms`;
        rerenderLastResults();
      } catch (error) {
        summaryEl.textContent = '検索エラー';
        errorBoxEl.textContent = error.message || String(error);
      }
    }, 20);
  } catch (error) {
    summaryEl.textContent = '入力エラー';
    errorBoxEl.textContent = error.message || String(error);
  }
}

function init() {
  loadDictionaries();
  updateInputMeta();
  searchBtnEl.addEventListener('click', runSearch);
  sortOrderEl.addEventListener('change', rerenderLastResults);
  sourceInputEl.addEventListener('input', updateInputMeta);
  sourceInputEl.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      runSearch();
    }
  });
}

try {
  init();
} catch (error) {
  summaryEl.textContent = '初期化エラー';
  errorBoxEl.textContent = error.message || String(error);
}
