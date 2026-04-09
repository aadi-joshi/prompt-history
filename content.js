'use strict';

(function () {
  // Per-tab, in-memory history. Resets on page reload or chat switch.
  let promptHistory = []; // submitted prompts, oldest first
  let historyIndex = -1;    // -1 means "not navigating history"
  let draft = null;         // unsaved draft text when navigation starts

  const MAX_HISTORY = 200;

  // Submission detection state
  let historyFetchedForCurrentInput = false;
  let submissionKeyPending = false;
  let submissionKeyTimer = null;
  let lastInputText = '';

  // Currently tracked input element and its cleanup handles
  let inputEl = null;
  let inputKeydownBound = false;
  let inputMutationObserver = null;
  let inputEventHandler = null; // reference so we can remove it

  // -------------------------------------------------------------------------
  // Site-specific selectors (tried in order, first match wins)
  // -------------------------------------------------------------------------

  function getSiteSelectors() {
    const host = location.hostname;
    if (host.includes('chatgpt.com')) {
      return ['#prompt-textarea'];
    }
    return ['div[contenteditable="true"]', 'textarea'];
  }

  function isVisible(el) {
    return el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0;
  }

  function findInputElement() {
    const selectors = getSiteSelectors();
    for (const sel of selectors) {
      const candidates = Array.from(document.querySelectorAll(sel)).filter(isVisible);
      if (candidates.length > 0) {
        // Prefer the largest visible element when multiple match
        candidates.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
        return candidates[0];
      }
    }
    // General fallback: largest visible contenteditable or textarea
    const all = Array.from(document.querySelectorAll('div[contenteditable="true"], textarea'))
      .filter(isVisible);
    if (all.length === 0) return null;
    all.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
    return all[0];
  }

  // -------------------------------------------------------------------------
  // Text get / set
  // -------------------------------------------------------------------------

  function getText(el) {
    if (el.tagName === 'TEXTAREA') return el.value;
    return el.innerText;
  }

  function setText(el, text) {
    el.focus();

    if (el.tagName === 'TEXTAREA') {
      // Use the native setter so React sees the change
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      ).set;
      nativeSetter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.selectionStart = el.selectionEnd = el.value.length;
      return;
    }

    // contenteditable: execCommand keeps React state in sync
    document.execCommand('selectAll');
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    moveCursorToEnd(el);
  }

  function moveCursorToEnd(el) {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // collapse to end
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // -------------------------------------------------------------------------
  // "Is cursor on first / last line?" checks
  // -------------------------------------------------------------------------

  // Returns true if the text has at most one line (no newlines in it).
  function isSingleLine(el) {
    return !getText(el).includes('\n');
  }

  function isOnFirstLine(el) {
    const text = getText(el);
    if (!text) return true;

    if (el.tagName === 'TEXTAREA') {
      // First line if no newline exists before the cursor
      return el.selectionStart === 0 || !text.substring(0, el.selectionStart).includes('\n');
    }

    // Single-line shortcut
    if (isSingleLine(el)) return true;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return true;

    const cursorRect = sel.getRangeAt(0).getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    // Zero rect: browser could not measure (e.g. cursor between inline nodes).
    // Fall back conservatively - only claim "first line" for single-line content,
    // which we already handled above, so return true here to allow navigation
    if (cursorRect.width === 0 && cursorRect.height === 0) return true;

    return cursorRect.top <= elRect.top + 10;
  }

  function isOnLastLine(el) {
    const text = getText(el);
    if (!text) return true;

    if (el.tagName === 'TEXTAREA') {
      // Last line if no newline exists after the cursor
      return el.selectionEnd === el.value.length || !text.substring(el.selectionEnd).includes('\n');
    }

    if (isSingleLine(el)) return true;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return true;

    const cursorRect = sel.getRangeAt(0).getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    if (cursorRect.width === 0 && cursorRect.height === 0) return true;

    return cursorRect.bottom >= elRect.bottom - 10;
  }

  // -------------------------------------------------------------------------
  // History navigation
  // -------------------------------------------------------------------------

  function navigateUp() {
    if (!historyFetchedForCurrentInput) {
      fetchPreexistingHistory();
    }
    if (promptHistory.length === 0) return;

    if (historyIndex === -1) {
      // First Up press: save whatever is in the input as a draft
      draft = getText(inputEl);
      historyIndex = promptHistory.length - 1;
    } else if (historyIndex > 0) {
      historyIndex--;
    } else {
      // Already at the oldest entry - stay put
      return;
    }

    setText(inputEl, promptHistory[historyIndex]);
  }

  function navigateDown() {
    if (historyIndex === -1) return; // not currently navigating

    if (historyIndex < promptHistory.length - 1) {
      historyIndex++;
      setText(inputEl, promptHistory[historyIndex]);
    } else {
      // Past the newest entry: restore draft
      historyIndex = -1;
      setText(inputEl, draft !== null ? draft : '');
      draft = null;
    }
  }

  // -------------------------------------------------------------------------
  // Submission detection and history push
  // -------------------------------------------------------------------------

  function pushToHistory(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Skip consecutive duplicates
    if (promptHistory.length > 0 && promptHistory[promptHistory.length - 1] === trimmed) return;
    promptHistory.push(trimmed);
    if (promptHistory.length > MAX_HISTORY) promptHistory.shift();
    // Reset navigation so next Up starts fresh from the new entry
    historyIndex = -1;
    draft = null;
  }

  // Called when Enter (without Shift) is detected. Captures text now, then
  // waits briefly to confirm the input was cleared (meaning it was a real submit).
  function onSubmissionKeyDown(capturedText) {
    lastInputText = capturedText; // ensure mutation observer has a fresh baseline
    submissionKeyPending = true;
    clearTimeout(submissionKeyTimer);
    submissionKeyTimer = setTimeout(function () {
      if (inputEl && getText(inputEl).trim() === '') {
        pushToHistory(capturedText);
      }
      submissionKeyPending = false;
    }, 2000);
  }

  // -------------------------------------------------------------------------
  // Key handler (capture phase to run before site handlers)
  // -------------------------------------------------------------------------

  function onKeyDown(e) {
    // Submission key: Enter without Shift
    if (e.key === 'Enter' && !e.shiftKey) {
      onSubmissionKeyDown(getText(inputEl));
      return;
    }

    if (e.key === 'ArrowUp') {
      if (isOnFirstLine(inputEl)) {
        e.preventDefault();
        navigateUp();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      // Only intercept Down when we are actively navigating history
      if (historyIndex !== -1 && isOnLastLine(inputEl)) {
        e.preventDefault();
        navigateDown();
      }
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Watch the input element for DOM mutations that signal a submit clear
  // -------------------------------------------------------------------------

  function watchInputMutations(el) {
    if (inputMutationObserver) {
      inputMutationObserver.disconnect();
      inputMutationObserver = null;
    }

    inputMutationObserver = new MutationObserver(function () {
      if (!submissionKeyPending) return;
      const current = getText(el).trim();
      if (current === '' && lastInputText.trim() !== '') {
        clearTimeout(submissionKeyTimer);
        pushToHistory(lastInputText);
        submissionKeyPending = false;
      }
      lastInputText = getText(el);
    });

    inputMutationObserver.observe(el, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // -------------------------------------------------------------------------
  // Fetch preexisting chat history from DOM
  // -------------------------------------------------------------------------

  function fetchPreexistingHistory() {
    // ChatGPT usually puts user messages in elements with data-message-author-role="user"
    const userNodes = document.querySelectorAll('[data-message-author-role="user"]');
    if (userNodes.length === 0) return; // not loaded yet or empty chat

    const newHistory = [];
    for (const node of userNodes) {
      // Find the inner text container to avoid capturing "You" or copy buttons
      // Often the prompt text is inside div.whitespace-pre-wrap
      let textContainer = node.querySelector('.whitespace-pre-wrap');
      if (!textContainer && node.innerText) {
        textContainer = node;
      }
      
      if (textContainer) {
        const text = textContainer.innerText.trim();
        // Skip consecutive duplicates or extremely short UI artifacts if any
        if (text && (newHistory.length === 0 || newHistory[newHistory.length - 1] !== text)) {
          newHistory.push(text);
        }
      }
    }
    
    if (newHistory.length > 0) {
      // Merge with locally submitted prompts. DOM nodes are usually older, local prompts are newer.
      const filteredLocal = promptHistory.filter(item => !newHistory.includes(item));
      promptHistory = [...newHistory, ...filteredLocal];
      
      // Cap at MAX_HISTORY to avoid huge stacks
      while (promptHistory.length > MAX_HISTORY) {
        promptHistory.shift();
      }
      historyFetchedForCurrentInput = true;
    }
  }

  // -------------------------------------------------------------------------
  // Attach to a detected input element, cleaning up the previous one
  // -------------------------------------------------------------------------

  function attachToInput(el) {
    if (el === inputEl) return; // already watching this element

    // Clean up previous element
    if (inputEl) {
      if (inputKeydownBound) {
        inputEl.removeEventListener('keydown', onKeyDown, true);
      }
      if (inputEventHandler) {
        inputEl.removeEventListener('input', inputEventHandler);
      }
    }
    if (inputMutationObserver) {
      inputMutationObserver.disconnect();
      inputMutationObserver = null;
    }

    inputEl = el;
    inputKeydownBound = false;
    inputEventHandler = null;

    // Reset navigation state for the new element
    historyFetchedForCurrentInput = false;
    historyIndex = -1;
    draft = null;
    lastInputText = getText(el);

    // Keydown at capture phase so we intercept before site code
    inputEl.addEventListener('keydown', onKeyDown, true);
    inputKeydownBound = true;

    // Input event to keep lastInputText current (textarea fallback + general)
    inputEventHandler = function () {
      lastInputText = getText(inputEl);
    };
    inputEl.addEventListener('input', inputEventHandler);

    watchInputMutations(inputEl);
  }

  // -------------------------------------------------------------------------
  // DOM observer to re-detect input after SPA navigation / React hydration
  // -------------------------------------------------------------------------

  let detectTimer = null;

  function scheduleDetect() {
    clearTimeout(detectTimer);
    detectTimer = setTimeout(detectAndAttach, 300);
  }

  function detectAndAttach() {
    const el = findInputElement();
    if (el) attachToInput(el);
  }

  const domObserver = new MutationObserver(function (mutations) {
    for (const m of mutations) {
      if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
        scheduleDetect();
        return;
      }
    }
  });

  domObserver.observe(document.body, { childList: true, subtree: true });

  // Run immediately in case the input already exists at injection time
  detectAndAttach();

})();
