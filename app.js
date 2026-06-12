(function () {
  "use strict";

  const STORAGE = {
    wrong: "localQuiz.wrongIds.v1",
    favorite: "localQuiz.favoriteIds.v1",
    records: "localQuiz.answerRecords.v1",
    progress: "localQuiz.progress.v1",
    importedBank: "localQuiz.importedBank.v1"
  };

  const dom = {
    bankStatus: document.getElementById("bankStatus"),
    fileInput: document.getElementById("fileInput"),
    modeButtons: Array.from(document.querySelectorAll("[data-mode]")),
    filterButtons: Array.from(document.querySelectorAll("[data-filter]")),
    questionCount: document.getElementById("questionCount"),
    recordStats: document.getElementById("recordStats"),
    restartBtn: document.getElementById("restartBtn"),
    clearRecordsBtn: document.getElementById("clearRecordsBtn"),
    emptyPanel: document.getElementById("emptyPanel"),
    emptyMessage: document.getElementById("emptyMessage"),
    quizPanel: document.getElementById("quizPanel"),
    typeBadge: document.getElementById("typeBadge"),
    progressText: document.getElementById("progressText"),
    progressBar: document.getElementById("progressBar"),
    favoriteBtn: document.getElementById("favoriteBtn"),
    questionTitle: document.getElementById("questionTitle"),
    optionsForm: document.getElementById("optionsForm"),
    resultPanel: document.getElementById("resultPanel"),
    prevBtn: document.getElementById("prevBtn"),
    submitBtn: document.getElementById("submitBtn"),
    nextBtn: document.getElementById("nextBtn")
  };

  const state = {
    questions: [],
    questionMap: new Map(),
    activeIds: [],
    mode: "sequence",
    filter: "all",
    currentIndex: 0,
    bankHash: "",
    bankSource: "",
    drafts: {}
  };

  const store = {
    wrongIds: new Set(readJson(STORAGE.wrong, [])),
    favoriteIds: new Set(readJson(STORAGE.favorite, [])),
    records: readJson(STORAGE.records, {})
  };

  bindEvents();
  loadInitialBank();

  function bindEvents() {
    dom.fileInput.addEventListener("change", handleFileImport);

    dom.modeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        state.mode = button.dataset.mode;
        rebuildPractice({ resetIndex: true, reshuffle: state.mode === "random" });
      });
    });

    dom.filterButtons.forEach((button) => {
      button.addEventListener("click", () => {
        state.filter = button.dataset.filter;
        rebuildPractice({ resetIndex: true, reshuffle: state.mode === "random" });
      });
    });

    dom.restartBtn.addEventListener("click", () => {
      rebuildPractice({ resetIndex: true, reshuffle: state.mode === "random" });
    });

    dom.clearRecordsBtn.addEventListener("click", clearRecords);
    dom.favoriteBtn.addEventListener("click", toggleFavorite);
    dom.prevBtn.addEventListener("click", () => moveQuestion(-1));
    dom.nextBtn.addEventListener("click", () => moveQuestion(1));
    dom.submitBtn.addEventListener("click", submitAnswer);

    window.addEventListener("beforeunload", saveProgress);
  }

  async function loadInitialBank() {
    const embeddedBank = getEmbeddedBankText();
    if (embeddedBank) {
      loadBankText(embeddedBank, "离线内置题库");
      return;
    }

    const fetched = await tryFetchQuestionsTxt();

    if (fetched) {
      loadBankText(fetched.text, fetched.source);
      return;
    }

    const cachedBank = localStorage.getItem(STORAGE.importedBank);
    if (cachedBank && cachedBank.trim()) {
      loadBankText(cachedBank, "上次导入的题库");
      return;
    }

    showEmpty("浏览器未能直接读取 questions.txt，请点击右上角“导入 txt”选择题库文件。");
  }

  function getEmbeddedBankText() {
    if (typeof window.EMBEDDED_QUESTIONS === "string" && window.EMBEDDED_QUESTIONS.trim()) {
      return window.EMBEDDED_QUESTIONS;
    }

    const embeddedNode = document.getElementById("embeddedQuestions");
    if (embeddedNode && embeddedNode.textContent.trim()) {
      return embeddedNode.textContent;
    }

    return "";
  }

  async function tryFetchQuestionsTxt() {
    try {
      const response = await fetch(`questions.txt?ts=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return null;

      const text = await response.text();
      if (!text.trim()) return null;

      return { text, source: "questions.txt" };
    } catch (error) {
      return null;
    }
  }

  async function handleFileImport(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    try {
      const text = await readTextFile(file);
      localStorage.setItem(STORAGE.importedBank, text);
      loadBankText(text, file.name);
      event.target.value = "";
    } catch (error) {
      showEmpty("题库文件读取失败，请确认文件是 txt 文本。");
    }
  }

  async function readTextFile(file) {
    const buffer = await file.arrayBuffer();
    let text = new TextDecoder("utf-8").decode(buffer);
    const badChars = (text.match(/\uFFFD/g) || []).length;

    if (badChars > 2 && "TextDecoder" in window) {
      try {
        text = new TextDecoder("gb18030").decode(buffer);
      } catch (error) {
        // 浏览器不支持 gb18030 时继续使用 UTF-8 结果。
      }
    }

    return text;
  }

  function loadBankText(text, source) {
    const questions = parseQuestions(text);

    if (!questions.length) {
      showEmpty("没有解析到题目，请检查题干、选项和“正确答案:”格式。");
      return;
    }

    state.questions = questions;
    state.questionMap = new Map(questions.map((question) => [question.id, question]));
    state.bankHash = hashString(text);
    state.bankSource = source;

    const savedProgress = readJson(STORAGE.progress, null);
    if (savedProgress && savedProgress.bankHash === state.bankHash) {
      state.mode = savedProgress.mode || "sequence";
      state.filter = savedProgress.filter || "all";
      state.currentIndex = Number(savedProgress.currentIndex) || 0;
      state.activeIds = Array.isArray(savedProgress.activeIds) ? savedProgress.activeIds : [];
      rebuildPractice({ resetIndex: false, useSavedOrder: true });
    } else {
      state.mode = "sequence";
      state.filter = "all";
      state.currentIndex = 0;
      rebuildPractice({ resetIndex: true });
    }
  }

  /*
   * 题库解析函数：
   * 1. 按章节标题识别题型，例如“一、单选题”“二、多选题”。
   * 2. 将选项行 A./B./C. 等解析为 options。
   * 3. 遇到“正确答案:”时收束当前题目，并把 ACD、A B C D、A、B、C 都转成答案数组。
   * 4. 如果题干自带 1.、1、或第1题，会提取为题号；否则使用解析顺序作为题号。
   */
  function parseQuestions(text) {
    const lines = text
      .replace(/^\uFEFF/, "")
      .replace(/\r/g, "")
      .split("\n");

    const questions = [];
    let currentType = "";
    let draft = null;

    const sectionPattern = /^(?:[一二三四五六七八九十百\d]+\s*[、.．]\s*)?(单选题|单项选择题|多选题|多项选择题)(?:\s|[（(]|$)/;
    const typeMetaPattern = /^(单选题|单项选择题|多选题|多项选择题)\s*[（(].*?[）)]\s*\d*\s*分?$/;
    const optionPattern = /^([A-Z])\s*[.．、)]\s*(.*)$/i;
    const optionKeyPattern = /^([A-Z])$/i;
    const optionMarkPattern = /^[.．、)]\s*(.*)$/;
    const answerPattern = /^(?:正确答案|参考答案|答案)\s*[:：]?\s*(.+)$/i;

    const ensureDraft = () => {
      if (!draft) {
        draft = {
          type: currentType,
          stemLines: [],
          options: {},
          lastOptionKey: ""
        };
      }
      return draft;
    };

    const startOption = (key, text) => {
      const item = ensureDraft();
      const optionKey = key.toUpperCase();
      item.options[optionKey] = text.trim();
      item.lastOptionKey = optionKey;
    };

    const finishDraft = (answerText) => {
      if (!draft) return;

      const optionKeys = Object.keys(draft.options).sort();
      const answer = normalizeAnswer(answerText, optionKeys);
      const rawStem = draft.stemLines.join("\n").trim();

      if (rawStem && optionKeys.length && answer.length) {
        const extracted = extractQuestionNumber(rawStem, questions.length + 1);
        const inferredType = answer.length > 1 ? "multiple" : "single";

        questions.push({
          id: "",
          number: extracted.number,
          order: questions.length + 1,
          type: draft.type || inferredType,
          stem: extracted.stem,
          options: optionKeys.map((key) => ({
            key,
            text: draft.options[key].trim()
          })),
          answer
        });
      }

      draft = null;
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = cleanQuestionLine(lines[index]);
      if (!line) continue;

      const typeMetaMatch = line.match(typeMetaPattern);
      if (typeMetaMatch) {
        const parsedType = typeMetaMatch[1].includes("多") ? "multiple" : "single";
        currentType = parsedType;
        if (draft) draft.type = parsedType;
        continue;
      }

      const sectionMatch = line.match(sectionPattern);
      if (sectionMatch && !optionPattern.test(line) && !answerPattern.test(line)) {
        currentType = sectionMatch[1].includes("多") ? "multiple" : "single";
        draft = null;
        continue;
      }

      if (!draft && isExportNoiseLine(line)) {
        continue;
      }

      const answerMatch = line.match(answerPattern);
      if (answerMatch) {
        finishDraft(answerMatch[1]);
        continue;
      }

      const optionMatch = line.match(optionPattern);
      if (optionMatch) {
        startOption(optionMatch[1], optionMatch[2]);
        continue;
      }

      const optionKeyMatch = line.match(optionKeyPattern);
      if (optionKeyMatch) {
        const marker = findNextNonEmptyLine(lines, index + 1);
        const markMatch = marker ? marker.line.match(optionMarkPattern) : null;
        if (markMatch) {
          startOption(optionKeyMatch[1], markMatch[1]);
          index = marker.index;
          continue;
        }
      }

      if (/^[.．、)]$/.test(line)) {
        continue;
      }

      const item = ensureDraft();
      if (item.lastOptionKey) {
        item.options[item.lastOptionKey] += `\n${line}`;
      } else {
        item.stemLines.push(line);
      }
    }

    const seenIds = new Map();
    questions.forEach((question) => {
      const rawId = hashString(`${question.type}|${question.stem}|${JSON.stringify(question.options)}|${question.answer.join("")}`);
      const count = (seenIds.get(rawId) || 0) + 1;
      seenIds.set(rawId, count);
      question.id = `q_${rawId}_${count}`;
    });

    return questions;
  }

  function cleanQuestionLine(line) {
    return line
      .trim()
      .replace(/\s*此题未答\s*$/g, "")
      .trim();
  }

  function findNextNonEmptyLine(lines, startIndex) {
    for (let index = startIndex; index < lines.length; index += 1) {
      const line = cleanQuestionLine(lines[index]);
      if (line) return { index, line };
    }
    return null;
  }

  function isExportNoiseLine(line) {
    const compact = line.replace(/\s+/g, "");

    return (
      /^\d+$/.test(compact) ||
      /^返回测试练习题库$/.test(compact) ||
      /^答题版本$/.test(compact) ||
      /^答题卡$/.test(compact) ||
      /^答对$/.test(compact) ||
      /^答错$/.test(compact) ||
      /^共\d+题$/.test(compact) ||
      /^试卷得分\d*$/.test(compact) ||
      /^\d{4}[./-]\d{1,2}[./-]\d{1,2}\d{1,2}:\d{2}$/.test(compact)
    );
  }

  function normalizeAnswer(answerText, optionKeys) {
    const allowed = new Set(optionKeys);
    const letters = (answerText.toUpperCase().match(/[A-Z]/g) || [])
      .filter((letter) => allowed.has(letter));

    return Array.from(new Set(letters)).sort();
  }

  function extractQuestionNumber(stem, fallbackNumber) {
    const cleaned = stem.trim();
    const match = cleaned.match(/^(?:第\s*)?(\d+)\s*(?:题)?[、.．:：)]\s*([\s\S]*)$/);

    if (match && match[2].trim()) {
      return {
        number: Number(match[1]),
        stem: match[2].trim()
      };
    }

    return {
      number: fallbackNumber,
      stem: cleaned
    };
  }

  function rebuildPractice(options = {}) {
    const { resetIndex = false, reshuffle = false, useSavedOrder = false } = options;
    const pool = getFilteredQuestions();
    const validIds = new Set(pool.map((question) => question.id));

    if (useSavedOrder && state.activeIds.length) {
      state.activeIds = state.activeIds.filter((id) => validIds.has(id));
    } else {
      state.activeIds = pool.map((question) => question.id);
    }

    if (state.mode === "random" && (reshuffle || !useSavedOrder)) {
      state.activeIds = shuffle(state.activeIds);
    }

    if (resetIndex) {
      state.currentIndex = 0;
    }

    if (state.currentIndex >= state.activeIds.length) {
      state.currentIndex = Math.max(0, state.activeIds.length - 1);
    }

    saveProgress();
    render();
  }

  function getFilteredQuestions() {
    return state.questions.filter((question) => {
      const matchType = state.filter === "all" || question.type === state.filter;
      if (!matchType) return false;

      if (state.mode === "wrong") {
        return store.wrongIds.has(question.id);
      }

      if (state.mode === "favorite") {
        return store.favoriteIds.has(question.id);
      }

      return true;
    });
  }

  function render() {
    updateActiveButtons();
    updateStats();

    if (!state.questions.length) {
      dom.quizPanel.classList.add("hidden");
      return;
    }

    if (!state.activeIds.length) {
      dom.quizPanel.classList.add("hidden");
      showEmpty(getEmptyTextForMode());
      return;
    }

    dom.emptyPanel.classList.add("hidden");
    dom.quizPanel.classList.remove("hidden");

    const question = getCurrentQuestion();
    const record = store.records[question.id];
    const selected = state.drafts[question.id] || (record ? record.selected : []);
    const isFavorite = store.favoriteIds.has(question.id);
    const percent = ((state.currentIndex + 1) / state.activeIds.length) * 100;

    dom.bankStatus.textContent = `${state.bankSource}，已加载 ${state.questions.length} 题`;
    dom.typeBadge.textContent = question.type === "multiple" ? "多选" : "单选";
    dom.progressText.textContent = `第 ${state.currentIndex + 1} / ${state.activeIds.length} 题，题号 ${question.number}`;
    dom.progressBar.style.width = `${percent}%`;
    dom.favoriteBtn.textContent = isFavorite ? "★" : "☆";
    dom.favoriteBtn.classList.toggle("active", isFavorite);
    dom.questionTitle.textContent = question.stem;

    renderOptions(question, selected, record);
    renderResult(question, record);

    dom.prevBtn.disabled = state.currentIndex === 0;
    dom.nextBtn.disabled = state.currentIndex >= state.activeIds.length - 1;
    dom.submitBtn.disabled = false;
  }

  function renderOptions(question, selected, record) {
    dom.optionsForm.innerHTML = "";
    const inputType = question.type === "multiple" ? "checkbox" : "radio";

    question.options.forEach((option) => {
      const label = document.createElement("label");
      label.className = "option-item";

      if (record) {
        const selectedThis = record.selected.includes(option.key);
        const correctThis = question.answer.includes(option.key);

        if (correctThis) label.classList.add("correct");
        if (selectedThis && !correctThis) label.classList.add("wrong");
      }

      const input = document.createElement("input");
      input.type = inputType;
      input.name = "answer";
      input.value = option.key;
      input.checked = selected.includes(option.key);
      input.addEventListener("change", () => {
        state.drafts[question.id] = getSelectedAnswers();
      });

      const text = document.createElement("span");
      text.className = "option-text";
      text.innerHTML = `<span class="option-key">${escapeHtml(option.key)}.</span> ${escapeHtml(option.text)}`;

      label.append(input, text);
      dom.optionsForm.appendChild(label);
    });
  }

  function renderResult(question, record) {
    if (!record) {
      dom.resultPanel.className = "result-panel hidden";
      dom.resultPanel.innerHTML = "";
      return;
    }

    const selectedText = record.selected.length ? record.selected.join(" ") : "未选择";
    const answerText = question.answer.join(" ");
    dom.resultPanel.className = `result-panel ${record.correct ? "correct" : "wrong"}`;
    dom.resultPanel.innerHTML = `
      <p><strong>${record.correct ? "回答正确" : "回答错误"}</strong></p>
      <p>你的答案：${escapeHtml(selectedText)}</p>
      <p>正确答案：${escapeHtml(answerText)}</p>
    `;
  }

  function submitAnswer() {
    const question = getCurrentQuestion();
    if (!question) return;

    const selected = getSelectedAnswers();
    if (!selected.length) {
      dom.resultPanel.className = "result-panel wrong";
      dom.resultPanel.innerHTML = "<p><strong>请先选择答案。</strong></p>";
      return;
    }

    const correct = arraysEqual(selected, question.answer);
    const previous = store.records[question.id];

    store.records[question.id] = {
      selected,
      correct,
      answeredAt: new Date().toISOString(),
      attempts: previous ? previous.attempts + 1 : 1
    };

    if (correct) {
      store.wrongIds.delete(question.id);
    } else {
      store.wrongIds.add(question.id);
    }

    state.drafts[question.id] = selected;
    saveStore();

    if ((state.mode === "wrong" && correct) || state.mode === "favorite") {
      rebuildPractice({ resetIndex: false, useSavedOrder: true });
    } else {
      saveProgress();
      render();
    }
  }

  function toggleFavorite() {
    const question = getCurrentQuestion();
    if (!question) return;

    if (store.favoriteIds.has(question.id)) {
      store.favoriteIds.delete(question.id);
    } else {
      store.favoriteIds.add(question.id);
    }

    saveStore();

    if (state.mode === "favorite") {
      rebuildPractice({ resetIndex: false, useSavedOrder: true });
    } else {
      render();
    }
  }

  function moveQuestion(step) {
    const nextIndex = state.currentIndex + step;
    if (nextIndex < 0 || nextIndex >= state.activeIds.length) return;

    state.currentIndex = nextIndex;
    saveProgress();
    render();
  }

  function clearRecords() {
    const confirmed = window.confirm("确定清空答题记录和错题本吗？收藏题会保留。");
    if (!confirmed) return;

    store.records = {};
    store.wrongIds.clear();
    state.drafts = {};
    saveStore();
    rebuildPractice({ resetIndex: true, reshuffle: state.mode === "random" });
  }

  function getSelectedAnswers() {
    return Array.from(dom.optionsForm.querySelectorAll("input[name='answer']:checked"))
      .map((input) => input.value)
      .sort();
  }

  function getCurrentQuestion() {
    return state.questionMap.get(state.activeIds[state.currentIndex]);
  }

  function updateActiveButtons() {
    dom.modeButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === state.mode);
    });

    dom.filterButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.filter === state.filter);
    });
  }

  function updateStats() {
    const singleCount = state.questions.filter((question) => question.type === "single").length;
    const multipleCount = state.questions.filter((question) => question.type === "multiple").length;
    const answeredCount = Object.keys(store.records).filter((id) => state.questionMap.has(id)).length;
    const wrongCount = Array.from(store.wrongIds).filter((id) => state.questionMap.has(id)).length;
    const favoriteCount = Array.from(store.favoriteIds).filter((id) => state.questionMap.has(id)).length;

    dom.questionCount.textContent = `题库 ${state.questions.length} 题（单选 ${singleCount} / 多选 ${multipleCount}）`;
    dom.recordStats.textContent = `已答 ${answeredCount} / 错题 ${wrongCount} / 收藏 ${favoriteCount}`;
  }

  function getEmptyTextForMode() {
    if (state.mode === "wrong") return "当前筛选下没有错题。";
    if (state.mode === "favorite") return "当前筛选下没有收藏题。";
    return "当前筛选下没有题目。";
  }

  function showEmpty(message) {
    dom.bankStatus.textContent = message;
    dom.emptyMessage.textContent = message;
    dom.emptyPanel.classList.remove("hidden");
    dom.quizPanel.classList.add("hidden");
    updateStats();
  }

  function saveStore() {
    localStorage.setItem(STORAGE.wrong, JSON.stringify(Array.from(store.wrongIds)));
    localStorage.setItem(STORAGE.favorite, JSON.stringify(Array.from(store.favoriteIds)));
    localStorage.setItem(STORAGE.records, JSON.stringify(store.records));
  }

  function saveProgress() {
    if (!state.bankHash) return;

    localStorage.setItem(STORAGE.progress, JSON.stringify({
      bankHash: state.bankHash,
      mode: state.mode,
      filter: state.filter,
      currentIndex: state.currentIndex,
      activeIds: state.activeIds
    }));
  }

  function readJson(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function arraysEqual(left, right) {
    if (left.length !== right.length) return false;
    return left.every((item, index) => item === right[index]);
  }

  function shuffle(items) {
    const result = items.slice();
    for (let index = result.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
    }
    return result;
  }

  function hashString(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
