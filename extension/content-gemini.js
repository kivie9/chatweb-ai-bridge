/**
 * Google Gemini Web Bridge Content Script v1.0
 * Tự động hóa nhập liệu, bấm Send, streaming phản hồi trên gemini.google.com
 */

(() => {
  const UTILS = (typeof window !== 'undefined' && window.__BRIDGE_UTILS__) || {};

  // Cơ chế phòng vệ: Nhận diện Extension Context còn hợp lệ hay đã bị reload/invalidated
  const isExtensionValid = UTILS.isExtensionValid || (() => {
    try {
      return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  });

  // Tránh nạp đè nếu script cùng version vẫn còn sống; nếu version mới hơn hoặc script cũ chết thì cho phép nạp mới
  const SCRIPT_VERSION = '1.7.0';
  if (window.__GEMINI_BRIDGE_LOADED__ && window.__GEMINI_BRIDGE_VERSION__ === SCRIPT_VERSION && window.__GEMINI_BRIDGE_IS_ALIVE__ && window.__GEMINI_BRIDGE_IS_ALIVE__()) {
    console.log('ℹ️ [Gemini Bridge] Content Script cùng phiên bản đã tồn tại, bỏ qua injection trùng lặp.');
    return;
  }
  window.__GEMINI_BRIDGE_LOADED__ = true;
  window.__GEMINI_BRIDGE_VERSION__ = SCRIPT_VERSION;
  window.__GEMINI_BRIDGE_IS_ALIVE__ = isExtensionValid;

  console.log('🚀 [Gemini Bridge v1.7] Content Script nạp thành công trên tab Google Gemini.');

  // Wrapper gửi tin an toàn tuyệt đối, không bao giờ ném Uncaught Error khi extension reload
  const safeSendMessage = UTILS.safeSendMessage || ((message) => {
    if (!isExtensionValid()) {
      return Promise.resolve(null);
    }
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === 'function') {
        return p.catch(() => null);
      }
      return Promise.resolve(p);
    } catch (_) {
      return Promise.resolve(null);
    }
  });

  // Bộ chọn DOM chính xác cho Google Gemini Web (đã xác thực trực tiếp trên DOM)
  const SELECTORS = {
    editor: [
      'rich-textarea div.ql-editor[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'rich-textarea .ql-editor',
      'div[contenteditable="true"]',
      'textarea[aria-label*="prompt"]',
      'textarea[aria-label*="Gemini"]',
      'textarea'
    ],
    sendButton: [
      'button[aria-label="Send message"]',
      'button[aria-label*="Send message"]',
      'button[aria-label*="Send"]',
      'gem-icon-button.send-button button',
      'div[data-test-id="send-button-container"] button',
      'button[aria-label*="Gửi tin nhắn"]',
      'button[aria-label*="Gửi"]',
      'button[aria-label*="Submit"]',
      'button.send-button',
      'button[data-test-id="send-button"]',
      'div.send-button-container button'
    ],
    stopButton: [
      'button[aria-label*="Stop response"]',
      'button[aria-label*="Stop generating"]',
      'button[aria-label*="Dừng phản hồi"]',
      'button[aria-label*="Dừng tạo"]',
      'button.stop-button',
      'div.send-button-container button[aria-label*="Stop"]',
      'div.send-button-container button[aria-label*="Dừng"]'
    ],
    modelResponse: [
      'model-response',
      'message-content',
      'div.model-response-text'
    ],
    errorBanner: [
      'div[class*="error-message"]',
      'div[class*="error-container"]',
      'div[class*="error"]',
      'div[role="alert"]',
      'snack-bar-container',
      'mat-snack-bar-container',
      'simple-snack-bar',
      '.response-error',
      'model-response [data-is-error="true"]',
      'model-response .error',
      'div.error-content'
    ]
  };

  // Nhận diện thông báo lỗi hệ thống từ Google Gemini Web (tiếng Anh & tiếng Việt)
  function isGeminiErrorText(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    const lower = trimmed.toLowerCase();

    // 1. Tiền tố lỗi đặc trưng từ hệ thống Gemini Web
    const errorPrefixes = [
      'sorry, something went wrong',
      'something went wrong',
      'please try your request again',
      'please try again',
      'an error occurred',
      'rất tiếc, đã xảy ra lỗi',
      'đã xảy ra lỗi',
      'vui lòng thử lại',
      'google workspace encountered an error'
    ];

    for (const prefix of errorPrefixes) {
      if (lower.startsWith(prefix) && lower.length < 350) {
        return true;
      }
    }

    // 2. Chứa toàn văn cụm từ lỗi trong đoạn phản hồi ngắn (< 300 ký tự)
    const errorPhrases = [
      'sorry, something went wrong. please try your request again',
      'sorry, something went wrong',
      'something went wrong. please try your request again',
      'something went wrong. please try again',
      'please try your request again',
      'an error occurred. please try again',
      'rất tiếc, đã xảy ra lỗi. vui lòng thử lại yêu cầu của bạn',
      'rất tiếc, đã xảy ra lỗi. vui lòng thử lại',
      'rất tiếc, đã xảy ra lỗi',
      'đã xảy ra lỗi. vui lòng thử lại yêu cầu',
      'đã xảy ra lỗi. vui lòng thử lại sau',
      'đã xảy ra lỗi. vui lòng thử lại',
      'vui lòng thử lại yêu cầu'
    ];

    for (const phrase of errorPhrases) {
      if (lower.includes(phrase) && lower.length < 300) {
        return true;
      }
    }

    // 3. Quá hạn mức / Rate limit / Quota
    if (lower.length < 250) {
      if (
        (lower.includes('quota') || lower.includes('usage limit') || lower.includes('rate limit') || lower.includes('giới hạn')) &&
        (lower.includes('exceeded') || lower.includes('reached') || lower.includes('vượt quá') || lower.includes('đạt') || lower.includes('hết'))
      ) {
        return true;
      }
    }

    return false;
  }

  function isElementVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (_) {
      return el.offsetWidth > 0 || el.offsetHeight > 0;
    }
  }

  function queryAnyVisible(selectors) {
    for (const sel of selectors) {
      try {
        const list = document.querySelectorAll(sel);
        for (const el of list) {
          if (isElementVisible(el)) return el;
        }
      } catch (_) {
        // Selector không hợp lệ hoặc DOM node không thể truy vấn — thử tiếp
      }
    }
    return null;
  }

  // Tìm chính xác nút Send của ô soạn thảo Gemini (loại bỏ nhầm lẫn nút Feedback, Mic, Audio)
  function findGeminiSendButton() {
    const editor = queryAny(SELECTORS.editor);
    const root = editor ? (editor.closest('.input-area-container') || editor.closest('form') || editor.closest('.text-input-field') || editor.parentElement?.parentElement?.parentElement || document) : document;

    const candidates = root.querySelectorAll('button, [role="button"]');
    for (const btn of candidates) {
      if (!isElementVisible(btn)) continue;
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();

      // Loại bỏ các nút feedback, mic, add file
      if (label.includes('phản hồi') || label.includes('feedback') || label.includes('voice') || label.includes('mic') || label.includes('audio') || label.includes('attach') || label.includes('tệp')) {
        continue;
      }

      // Nhận diện nút Send thực thụ
      if (
        label === 'send message' ||
        label === 'gửi tin nhắn' ||
        label === 'gửi' ||
        label.includes('send message') ||
        label.includes('gửi tin nhắn') ||
        label.includes('send prompt') ||
        label.includes('gửi lời nhắc') ||
        btn.classList.contains('send-button') ||
        btn.getAttribute('data-test-id') === 'send-button' ||
        btn.getAttribute('mattooltip')?.toLowerCase().includes('send') ||
        btn.getAttribute('mattooltip')?.toLowerCase().includes('gửi')
      ) {
        return btn;
      }
    }
    return null;
  }

  // Tìm nút Stop khi Gemini đang sinh phản hồi
  function findGeminiStopButton() {
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      if (!isElementVisible(btn)) continue;
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const tooltip = (btn.getAttribute('mattooltip') || '').toLowerCase();

      if (
        label.includes('stop') ||
        label.includes('dừng') ||
        tooltip.includes('stop') ||
        tooltip.includes('dừng') ||
        btn.classList.contains('stop-button') ||
        btn.getAttribute('data-test-id')?.includes('stop')
      ) {
        return btn;
      }

      // Kiểm tra mat-icon hoặc svg stop bên trong
      const matIcon = btn.querySelector('mat-icon');
      if (matIcon) {
        const iconText = (matIcon.innerText || matIcon.textContent || '').trim().toLowerCase();
        const fontIcon = (matIcon.getAttribute('fonticon') || '').toLowerCase();
        if (iconText === 'stop' || fontIcon === 'stop' || iconText === 'pause' || fontIcon === 'pause') {
          return btn;
        }
      }
    }
    return null;
  }

  // Kiểm tra Gemini có đang trong quá trình sinh phản hồi hoặc suy nghĩ (thinking) hay không
  function isGeminiGenerating() {
    // 1. Có nút Stop hiển thị
    if (findGeminiStopButton()) return true;

    // 2. Thẻ pending-response, pending-request hoặc thinking-dots-animation, gpi-static-text-loader (mẫu dom-samples/gemini.html)
    if (document.querySelector('pending-response, pending-request, thinking-dots-animation, .thinking-dots-animation, .gpi-static-text-loader')) {
      return true;
    }

    // 3. Có progress bar bên trong vùng chat area (không query ra ngoài body/sidebar)
    const chatArea = document.querySelector('chat-window, main, [role="main"]');
    if (chatArea) {
      const progress = chatArea.querySelector('mat-progress-bar, .loading-indicator');
      if (progress && isElementVisible(progress)) return true;
    }

    return false;
  }

  function isSendButtonAvailable() {
    const btn = findGeminiSendButton();
    if (!btn || !isElementVisible(btn)) return false;
    const isDisabled = btn.hasAttribute('disabled') ||
                       btn.getAttribute('aria-disabled') === 'true' ||
                       btn.classList.contains('disabled');
    return !isDisabled;
  }

  const queryAny = UTILS.queryAny || ((selectors, root = document) => {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  });

  const queryAllAny = UTILS.queryAllAny || ((selectors, root = document) => {
    for (const sel of selectors) {
      try {
        const list = root.querySelectorAll(sel);
        if (list && list.length > 0) return Array.from(list);
      } catch (_) {}
    }
    return [];
  });

  function reportProgress(text) {
    console.log('[Gemini Bridge] ' + text);
    safeSendMessage({ action: 'LOG', text: `[Gemini Tab] ${text}` });
  }

  const sleep = UTILS.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));

  // Bóc tách text, bảo tồn Code Blocks và Hình ảnh phản hồi trong câu trả lời của Gemini
  // Tuân thủ nghiêm ngặt TrustedHTML của Google (dùng TextNode thay vì outerHTML/innerHTML)
  function extractGeminiMarkdown(container) {
    if (!container) return '';
    const contentRoot = container.querySelector('message-content') ||
                        container.querySelector('div.markdown') ||
                        container.querySelector('div.response-content') ||
                        container;

    // Lấy nội dung trực tiếp từ live DOM element trước (chuẩn TrustedHTML và không bị mất trên detached clone)
    const raw = (contentRoot.innerText || contentRoot.textContent || '').trim();

    const codeBlocks = contentRoot.querySelectorAll('code-block');
    const liveImgs = Array.from(contentRoot.querySelectorAll('img'));

    if (codeBlocks.length > 0 || liveImgs.length > 0) {
      try {
        const liveInfos = liveImgs.map((img) => {
          try {
            let src = (img.currentSrc || img.src || img.getAttribute('src') || '').trim();
            if (!src || src.startsWith('chrome-extension://')) return { isContent: false };
            const lowerSrc = src.toLowerCase();
            if (lowerSrc.includes('google.com/s2/favicons') || lowerSrc.includes('favicons?domain') || lowerSrc.includes('favicon.ico')) {
              return { isContent: false };
            }
            const attrW = parseInt(img.getAttribute('width') || '0', 10);
            const attrH = parseInt(img.getAttribute('height') || '0', 10);
            if ((attrW > 0 && attrW <= 36) || (attrH > 0 && attrH <= 36)) return { isContent: false };
            const rect = img.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.width <= 36 && rect.height <= 36) return { isContent: false };
            const alt = (img.getAttribute('alt') || 'Image').replace(/[\r\n\[\]]+/g, ' ').trim() || 'Image';
            return { isContent: true, src, alt };
          } catch (_) {
            return { isContent: false };
          }
        });

        const clone = contentRoot.cloneNode(true);
        const cloneImgs = Array.from(clone.querySelectorAll('img'));
        const seenUrls = new Set();

        for (let i = 0; i < cloneImgs.length; i++) {
          const cImg = cloneImgs[i];
          const info = liveInfos[i];
          if (info && info.isContent && !seenUrls.has(info.src)) {
            seenUrls.add(info.src);
            const parentBtn = cImg.closest('button, gem-icon-button');
            if (parentBtn) parentBtn.setAttribute('data-bridge-keep', '1');
            cImg.replaceWith(document.createTextNode(`\n![${info.alt}](${info.src})\n`));
          } else {
            cImg.remove();
          }
        }

        clone.querySelectorAll('h6, [aria-label*="Gemini said"], button, gem-icon-button, .code-block-decoration .buttons').forEach(el => {
          if (el.hasAttribute('data-bridge-keep') || el.querySelector('[data-bridge-keep]')) return;
          try { el.remove(); } catch (_) { /* Node đã bị detach khỏi DOM — an toàn bỏ qua */ }
        });
        clone.querySelectorAll('code-block').forEach((block) => {
          try {
            const langEl = block.querySelector('.code-block-decoration span, .header-formatted span');
            const lang = (langEl?.innerText || langEl?.textContent || '').trim().toLowerCase();
            const codeEl = block.querySelector('code[data-test-id="code-content"], pre code, code') || block;
            const codeText = codeEl.innerText || codeEl.textContent || '';
            const textNode = document.createTextNode(`\n\`\`\`${lang}\n${codeText.trim()}\n\`\`\`\n`);
            block.replaceWith(textNode);
          } catch (_) {
            /* Bỏ qua nếu block code có cấu trúc dị thường */
          }
        });
        const formatted = (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
        if (formatted.length > 0) return formatted;
      } catch (_) {
        // Fallback về raw text nếu cloneNode gặp sự cố
      }
    }

    return raw;
  }

  // Nhập văn bản vào trình soạn thảo của Gemini (Quill / Rich-Textarea)
  async function enterTextIntoGemini(editor, text) {
    reportProgress('1. Chuẩn bị ô nhập liệu Gemini...');
    editor.focus();
    editor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    editor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(100);

    // 1. Xóa nội dung cũ nếu có
    try {
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (_) {
      // Selection range lỗi trên editor bị ẩn hoặc chưa mount
    }

    // 2. Chèn text bằng execCommand (an toàn 100% với TrustedHTML của Google)
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch (_) {
      // execCommand có thể bị trình duyệt chặn ở một số bối cảnh
    }

    // 3. Fallback an toàn TrustedHTML nếu execCommand không hoạt động
    const hasText = () => (editor.textContent || editor.innerText || '').trim().length > 0;

    if (!ok || !hasText()) {
      try {
        while (editor.firstChild) editor.removeChild(editor.firstChild);
        const p = document.createElement('p');
        const lines = text.split('\n');
        lines.forEach((line, i) => {
          if (i > 0) p.appendChild(document.createElement('br'));
          if (line) p.appendChild(document.createTextNode(line));
        });
        editor.appendChild(p);
      } catch (_) {
        // Fallback DOM manipulation thất bại nếu node bị lock
      }
    }

    // 4. Kích hoạt chuỗi sự kiện để Angular / Lit State của Gemini nhận diện văn bản
    editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true }));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));

    await sleep(200);
    reportProgress('2. Đã nhập xong nội dung vào Gemini (' + text.length + ' ký tự)');
  }

  // Kích hoạt gửi câu hỏi với cơ chế kiểm tra đa tầng isSent
  async function triggerSendGemini(editor, initialCount = 0, initialQueryCount = 0) {
    const maxWaitMs = 15000;
    const startTime = Date.now();
    let nudged = false;
    let clickSent = false;
    let enterSent = false;
    let lastReportedStatus = '';

    const isSent = () => {
      // 1. Trạng thái sinh hoặc nút Stop hoặc pending-request/thinking-dots đã xuất hiện
      if (isGeminiGenerating()) return true;

      // 2. Thẻ user-query mới đã xuất hiện trong thread (chứng minh 100% tin nhắn đã được gửi lên hệ thống)
      const currentQueryCount = document.querySelectorAll('user-query').length;
      if (currentQueryCount > initialQueryCount) return true;

      // 3. Số lượng thẻ model-response đã tăng thêm
      if (queryAllAny(SELECTORS.modelResponse).length > initialCount) return true;

      // 4. Text trong ô soạn thảo đã được dọn sạch hoàn toàn sau khi bấm gửi
      const textRemaining = (editor.textContent || editor.innerText || '').trim();
      if (clickSent && (textRemaining.length === 0 || textRemaining === '\n' || textRemaining === '\u200B')) return true;

      return false;
    };

    reportProgress('3. Đang kích hoạt gửi câu hỏi lên Gemini...');

    while (Date.now() - startTime < maxWaitMs) {
      if (isSent()) {
        reportProgress('🚀 Tin nhắn đã được gửi đi thành công!');
        return true;
      }

      const sendBtn = findGeminiSendButton();
      if (sendBtn) {
        const isDisabled = sendBtn.hasAttribute('disabled') ||
                           btnAriaDisabled(sendBtn) ||
                           sendBtn.classList.contains('disabled');
        if (!isDisabled) {
          if (!clickSent) {
            clickSent = true;
            reportProgress('4. Đang click nút Gửi tin nhắn...');
            sendBtn.focus();
            sendBtn.click();

            // Cho Gemini ít nhất 600ms để chuyển sang trạng thái pending
            await sleep(600);
            continue;
          }
        } else {
          const msg = '⏳ Nút Gửi đang chờ sẵn sàng...';
          if (lastReportedStatus !== msg) {
            lastReportedStatus = msg;
            reportProgress(msg);
          }
        }
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);

      // Kích thích ô soạn thảo nếu nút Send chưa sáng
      if (elapsed >= 2 && !nudged) {
        nudged = true;
        reportProgress('⚡ Đang kích thích ô soạn thảo để hiện nút Gửi...');
        editor.focus();
        document.execCommand('insertText', false, ' ');
        document.execCommand('delete', false, null);
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
      }

      // Fallback: Nếu đã click send mà sau 2s chưa thấy gửi, hoặc không tìm thấy nút Send -> Bấm Enter trên editor
      if (elapsed >= 2 && !enterSent) {
        enterSent = true;
        reportProgress('⚡ Kích hoạt phím Enter trên ô soạn thảo...');
        editor.focus();
        const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true, shiftKey: false };
        editor.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
        editor.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
        await sleep(600);
      }

      await sleep(350);
    }

    if (isSent()) {
      return true;
    }

    throw new Error('Nút Gửi của Gemini không khả dụng hoặc không phản hồi sau 15 giây. Vui lòng kiểm tra lại tab gemini.google.com.');
  }

  function btnAriaDisabled(btn) {
    return btn.getAttribute('aria-disabled') === 'true';
  }

  // Trạng thái điều phối đơn nhiệm & hủy tác vụ
  let isExecuting = false;
  let activeTaskId = null;
  let activePollTimer = null;
  let activeReject = null;

  function cleanupActiveTask() {
    if (activePollTimer) {
      clearInterval(activePollTimer);
      activePollTimer = null;
    }
    isExecuting = false;
    activeTaskId = null;
    activeReject = null;
  }

  // Bắt luồng phản hồi và streaming từ Gemini với cơ chế chống resolve sớm
  function monitorGeminiResponse(request, initialCount, initialLastText, timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let hasStarted = false;
      let seenGenerating = false;
      let lastText = '';
      let stableCount = 0;
      let lastSentLength = 0;
      let lastTextChangeTime = Date.now();

      activeReject = reject;

      activePollTimer = setInterval(() => {
        // Guard: Extension context còn hợp lệ không?
        if (!isExtensionValid()) {
          cleanupActiveTask();
          console.log('⚠️ [Gemini Bridge] Extension context đã bị vô hiệu hóa do reload tiện ích.');
          reject(new Error('Extension context invalidated'));
          return;
        }

        // 1. Kiểm tra lỗi hệ thống hoặc quota banner trên tab Gemini
        for (const sel of SELECTORS.errorBanner) {
          try {
            const list = document.querySelectorAll(sel);
            for (const errEl of list) {
              if (isElementVisible(errEl)) {
                const errText = (errEl.innerText || errEl.textContent || '').trim();
                if (errText.length > 0 && (
                  isGeminiErrorText(errText) ||
                  errText.toLowerCase().includes('error') ||
                  errText.toLowerCase().includes('lỗi') ||
                  errText.toLowerCase().includes('quota') ||
                  errText.toLowerCase().includes('something went wrong') ||
                  errText.toLowerCase().includes('try again')
                )) {
                  cleanupActiveTask();
                  console.log(`❌ [Gemini Bridge] Phát hiện banner lỗi: "${errText}"`);
                  reportProgress(`❌ Gemini báo lỗi: ${errText}`);
                  reject(new Error(`Gemini Web Error: ${errText}`));
                  return;
                }
              }
            }
          } catch (_) {}
        }

        // 1.1 Kiểm tra phần tử thông báo lỗi xuất hiện ngay sau user-query mới nhất
        try {
          const userQueries = document.querySelectorAll('user-query');
          if (userQueries.length > 0) {
            const lastQuery = userQueries[userQueries.length - 1];
            let nextEl = lastQuery.nextElementSibling;
            while (nextEl) {
              const text = (nextEl.innerText || nextEl.textContent || '').trim();
              if (text.length > 0 && isGeminiErrorText(text)) {
                cleanupActiveTask();
                console.log(`❌ [Gemini Bridge] Phát hiện thông báo lỗi sau user-query: "${text}"`);
                reportProgress(`❌ Gemini báo lỗi: ${text}`);
                reject(new Error(`Gemini Web Error: ${text}`));
                return;
              }
              nextEl = nextEl.nextElementSibling;
            }
          }
        } catch (_) {}

        // Tự động tắt popup nhắc đăng nhập nếu bất ngờ xuất hiện
        dismissModals();

        // 2. Kiểm tra trạng thái AI đang sinh (Stop button, Shimmer, Progress)
        const isGenerating = isGeminiGenerating();
        if (isGenerating) {
          seenGenerating = true;
        }

        // 3. Trích xuất văn bản phản hồi mới
        const responses = queryAllAny(SELECTORS.modelResponse);
        let currentText = '';
        let isNewTurn = false;

        if (responses.length > initialCount) {
          // Thẻ model-response mới đã xuất hiện
          const lastEl = responses[responses.length - 1];
          currentText = extractGeminiMarkdown(lastEl);
          isNewTurn = true;
        } else if (responses.length > 0) {
          const lastEl = responses[responses.length - 1];
          const rawText = extractGeminiMarkdown(lastEl);
          if (initialCount === 0) {
            currentText = rawText;
            isNewTurn = true;
          } else if (rawText !== initialLastText) {
            currentText = rawText;
            isNewTurn = true;
          } else {
            // Vẫn là câu trả lời của lượt cũ -> Giữ currentText là rỗng
            currentText = '';
            isNewTurn = false;
          }
        }

        // 3.1 Chặn ngay lập tức nếu nội dung hoặc container phản hồi là thông báo lỗi
        if (isNewTurn) {
          if (currentText.length > 0 && isGeminiErrorText(currentText)) {
            cleanupActiveTask();
            console.log(`❌ [Gemini Bridge] Phát hiện câu trả lời là thông báo lỗi: "${currentText}"`);
            reportProgress(`❌ Gemini báo lỗi: ${currentText}`);
            reject(new Error(`Gemini Web Error: ${currentText}`));
            return;
          }

          if (responses.length > 0) {
            const lastEl = responses[responses.length - 1];
            const rawContainerText = (lastEl.innerText || lastEl.textContent || '').trim();
            if (rawContainerText.length > 0 && isGeminiErrorText(rawContainerText)) {
              cleanupActiveTask();
              console.log(`❌ [Gemini Bridge] Phát hiện container phản hồi chứa lỗi: "${rawContainerText}"`);
              reportProgress(`❌ Gemini báo lỗi: ${rawContainerText}`);
              reject(new Error(`Gemini Web Error: ${rawContainerText}`));
              return;
            }

            // Kiểm tra nút Retry (Thử lại) xuất hiện bên trong model-response do lỗi
            const retryBtn = lastEl.querySelector('button[aria-label*="Retry"], button[aria-label*="Thử lại"], button.retry-button');
            if (retryBtn && rawContainerText.length < 350) {
              cleanupActiveTask();
              console.log(`❌ [Gemini Bridge] Phát hiện nút Thử lại (Retry) do lỗi: "${rawContainerText}"`);
              reportProgress(`❌ Gemini báo lỗi: ${rawContainerText || 'Sorry, something went wrong. Please try your request again.'}`);
              reject(new Error(`Gemini Web Error: ${rawContainerText || 'Sorry, something went wrong. Please try your request again.'}`));
              return;
            }
          }
        }

        // 4. Đánh dấu đã bắt đầu sinh câu trả lời
        if (!hasStarted) {
          if (isGenerating || responses.length > initialCount || (isNewTurn && currentText.length > 0)) {
            hasStarted = true;
            lastText = currentText;
            lastTextChangeTime = Date.now();
            reportProgress('📡 Gemini đã bắt đầu sinh câu trả lời...');
          }
        }

        // 5. Streaming chunk (chỉ bắn khi ĐÃ là lượt mới, có text mới và KHÔNG phải lỗi)
        if (request.stream && isNewTurn && currentText.length > lastSentLength && !isGeminiErrorText(currentText)) {
          const chunk = currentText.slice(lastSentLength);
          lastSentLength = currentText.length;
          safeSendMessage({ action: 'STREAM_CHUNK', id: request.id, chunk, fullText: currentText });
        }

        // 6. Đánh giá hoàn tất
        if (isGenerating) {
          // AI vẫn đang sinh hoặc đang suy nghĩ (thinking) — theo dõi text thay đổi
          if (currentText !== lastText) {
            lastText = currentText;
            lastTextChangeTime = Date.now();
          }
          stableCount = 0;
        } else if (hasStarted) {
          // AI không còn hiển thị animation/stop/pending nữa -> Theo dõi ổn định văn bản để hoàn tất
          if (isNewTurn && currentText.length > 0) {
            if (currentText === lastText) {
              stableCount++;

              // Ngưỡng ổn định văn bản:
              // - Đã thấy stop/shimmer/thinking: cần text đứng yên ít nhất 3 nhịp (~1.3s)
              // - Chưa thấy stop/shimmer: cần text đứng yên ít nhất 5 nhịp (~2.2s) để chống rớt chunk
              const requiredCount = seenGenerating ? 3 : 5;

              if (stableCount >= requiredCount) {
                const sendBtn = findGeminiSendButton();
                const sendReady = isSendButtonAvailable();

                // Nếu tìm thấy send button nhưng vẫn bị disabled -> AI vẫn chưa hoàn toàn sẵn sàng
                if (sendBtn && !sendReady && stableCount < 9) {
                  return;
                }

                if (isGeminiErrorText(currentText)) {
                  cleanupActiveTask();
                  console.log(`❌ [Gemini Bridge] Từ chối resolve vì phát hiện lỗi: "${currentText}"`);
                  reportProgress(`❌ Gemini báo lỗi: ${currentText}`);
                  reject(new Error(`Gemini Web Error: ${currentText}`));
                  return;
                }

                cleanupActiveTask();
                reportProgress(`🎉 Gemini đã hoàn tất phản hồi (${currentText.length} ký tự)!`);
                resolve(currentText);
                return;
              }
            } else {
              lastText = currentText;
              lastTextChangeTime = Date.now();
              stableCount = 0;
            }
          }
        }

        // 7. Chốt chặn an toàn (Watchdog Text Invariant):
        // Nếu đã bắt đầu, có text mới (> 20 ký tự), KHÔNG còn trong trạng thái generating, và text hoàn toàn không thay đổi trong 7 giây
        if (hasStarted && isNewTurn && currentText.length > 20 && !isGenerating && (Date.now() - lastTextChangeTime > 7000)) {
          cleanupActiveTask();
          if (isGeminiErrorText(currentText)) {
            console.log(`❌ [Gemini Bridge] Watchdog phát hiện lỗi: "${currentText}"`);
            reportProgress(`❌ Gemini báo lỗi: ${currentText}`);
            reject(new Error(`Gemini Web Error: ${currentText}`));
            return;
          }
          reportProgress(`🎉 Gemini hoàn tất (Watchdog Text Invariant, ${currentText.length} ký tự)!`);
          resolve(currentText);
          return;
        }

        // 8. Timeout toàn cục
        if (Date.now() - startTime > timeoutMs) {
          cleanupActiveTask();
          if (isNewTurn && currentText.length > 0 && !isGeminiErrorText(currentText)) {
            reportProgress(`⚠️ Timeout nhưng có ${currentText.length} ký tự mới, trả về kết quả hiện tại.`);
            resolve(currentText);
          } else {
            const finalErr = isGeminiErrorText(currentText)
              ? `Gemini Web Error: ${currentText}`
              : `Timeout: Quá thời gian chờ phản hồi từ Gemini (${timeoutMs / 1000}s)`;
            reject(new Error(finalErr));
          }
        }
      }, 450);
    });
  }

  // Đóng các popup/modal nhắc đăng nhập hoặc gợi ý nếu xuất hiện
  function dismissModals() {
    try {
      const dismissBtns = Array.from(document.querySelectorAll('button')).filter(b => {
        const text = (b.innerText || '').trim().toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        return text === 'not now' || text === 'không phải bây giờ' || aria === 'not now' || aria === 'dismiss';
      });
      dismissBtns.forEach(b => b.click());
    } catch (_) {
      // Phớt lờ lỗi nếu modal DOM không thể truy cập
    }
  }

  // Xử lý yêu cầu ASK từ background
  async function handleGeminiAsk(request) {
    dismissModals();

    // 0. CHỐT CHẶN: Nếu Gemini đang bận suy nghĩ hoặc sinh câu trả lời trước đó, chờ đến khi rảnh hoàn toàn
    if (isGeminiGenerating()) {
      reportProgress('⏳ Tab Gemini đang suy nghĩ / sinh câu trả lời trước đó. Đang đợi tab hoàn tất...');
      const waitStart = Date.now();
      while (isGeminiGenerating() && (Date.now() - waitStart < 120000)) {
        await sleep(500);
      }
      if (isGeminiGenerating()) {
        throw new Error('Tab Gemini vẫn đang bận suy nghĩ / xử lý sau 120s. Vui lòng thử lại.');
      }
      await sleep(600); // Chờ DOM settle
    }

    const editor = queryAny(SELECTORS.editor);
    if (!editor) {
      throw new Error('Không tìm thấy ô nhập câu hỏi trên Google Gemini. Vui lòng kiểm tra tab gemini.google.com.');
    }

    // Chuyển Data URL (Base64) sang File object để nạp vào trang web (tái sử dụng từ UTILS)
    const dataUrlToFile = UTILS.dataUrlToFile || function(dataUrl, defaultName = 'upload.png') {
      try {
        const parts = dataUrl.split(',');
        if (parts.length < 2) return null;
        const mimeMatch = parts[0].match(/:(.*?);/);
        const mime = mimeMatch ? mimeMatch[1] : 'image/png';
        const bstr = atob(parts[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) {
          u8arr[n] = bstr.charCodeAt(n);
        }
        const ext = mime.split('/')[1] || 'png';
        const filename = defaultName.includes('.') ? defaultName : `${defaultName}.${ext}`;
        return new File([u8arr], filename, { type: mime });
      } catch (e) {
        console.log('⚠️ [Gemini Bridge] Lỗi dataUrlToFile:', e.message);
        return null;
      }
    };

    // Quét tìm tất cả input[type="file"] trong cả DOM thường và các tầng Shadow DOM
    function findAllGeminiFileInputs() {
      const inputs = [];
      function walk(node) {
        if (!node) return;
        if (node.querySelectorAll) {
          try {
            const list = node.querySelectorAll('input[type="file"]');
            for (const item of list) inputs.push(item);
          } catch (e) {}
        }
        if (node.shadowRoot) {
          walk(node.shadowRoot);
        }
        const children = node.children || [];
        for (const child of children) {
          walk(child);
        }
      }
      walk(document.body || document.documentElement);
      return inputs;
    }

    // Kiểm tra xem Gemini đã hiển thị preview ảnh được tải lên trong khung nhập liệu chưa
    function hasGeminiUploadedPreview() {
      const selectors = [
        'uploader-preview-card',
        'xap-deferred-uploader img',
        '[data-test-id*="preview"]',
        'div[class*="preview"] img',
        '.file-preview-container img',
        'div[class*="preview-card"]',
        'div[class*="attachment"]',
        'div[class*="file-preview"]',
        'img[src^="blob:"]',
        'img[src^="data:image/"]',
        '.attachment-container'
      ];
      for (const sel of selectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (el.closest('user-query') || el.closest('model-response')) continue;
            if (!isElementVisible(el)) continue;
            if (el.tagName === 'IMG' || el.children.length > 0 || el.querySelector('img, mat-progress-bar, mat-progress-spinner, mat-spinner')) {
              return true;
            }
          }
        } catch (e) {}
      }
      return false;
    }

    // Kiểm tra xem ảnh đính kèm trong vùng nhập liệu có đang upload spinner hay không
    function isGeminiImageUploading() {
      const inputArea = document.querySelector('input-area-v2, input-area, .input-area-container, uploader-preview-card, xap-deferred-uploader');
      if (!inputArea) return false;
      const spinners = inputArea.querySelectorAll('mat-progress-spinner, mat-spinner, mat-progress-bar, [role="progressbar"]');
      for (const sp of spinners) {
        if (isElementVisible(sp)) return true;
      }
      return false;
    }

    // Chờ hình ảnh upload xong trên Gemini
    async function waitForGeminiImageUpload(maxWaitMs = 15000) {
      const startTime = Date.now();
      reportProgress('Đang đợi hình ảnh tải lên máy chủ Google Gemini...');
      while (Date.now() - startTime < maxWaitMs) {
        if (hasGeminiUploadedPreview()) {
          // Chờ spinner upload hoàn tất nếu có (tối đa 8 giây)
          const spinStart = Date.now();
          while (isGeminiImageUploading() && (Date.now() - spinStart < 8000)) {
            await sleep(300);
          }
          await sleep(600);
          reportProgress('Hình ảnh đã tải lên Google Gemini thành công!');
          return true;
        }
        await sleep(350);
      }
      reportProgress('Hết thời gian chờ preview ảnh Gemini, tiếp tục gửi câu hỏi...');
      return false;
    }

    // Nạp hình ảnh vào Gemini Web (Ưu tiên thực thi trực tiếp trong MAIN World qua Background, fallback cục bộ nếu cần)
    async function uploadImagesToGemini(editor, images) {
      if (!Array.isArray(images) || images.length === 0) return;
      reportProgress(`Đang nạp ${images.length} hình ảnh vào Google Gemini...`);

      // CHIẾN LƯỢC CHÍNH: Thực thi trực tiếp trong MAIN World để không bị mất DataTransfer qua ranh giới ISOLATED World
      try {
        const mainRes = await safeSendMessage({
          action: 'UPLOAD_IMAGES_MAIN_WORLD',
          images
        });
        if (mainRes && mainRes.ok) {
          reportProgress(`Nạp ảnh thành công qua MAIN World (${mainRes.method || 'auto'}).`);
          await waitForGeminiImageUpload();
          return;
        }
        if (mainRes && mainRes.error) {
          reportProgress(`MAIN World notice: ${mainRes.error}, chuyển sang fallback cục bộ...`);
        }
      } catch (mainErr) {
        reportProgress(`MAIN World bridge notice: ${mainErr.message}`);
      }

      const files = [];
      for (let i = 0; i < images.length; i++) {
        const f = dataUrlToFile(images[i], `gemini_image_${i + 1}.png`);
        if (f) files.push(f);
      }

      if (files.length === 0) {
        reportProgress('Không thể phân giải file ảnh từ Data URL.');
        return;
      }

      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));

      const targets = Array.from(new Set([
        editor,
        editor.closest('rich-textarea'),
        editor.closest('input-area-v2'),
        editor.closest('.input-area-container'),
        editor.parentElement,
        document.querySelector('rich-textarea'),
        document.querySelector('input-area-v2'),
        document.querySelector('input-area'),
        document.querySelector('xap-deferred-uploader')
      ].filter(Boolean)));

      // FALLBACK 1: Synthetic ClipboardEvent('paste')
      reportProgress('1. Fallback: Nạp ảnh qua ClipboardEvent paste...');
      try { window.focus(); } catch (_) {}
      try { editor.focus(); } catch (_) {}

      for (const t of targets) {
        try {
          t.focus();
          const pasteEvt = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            composed: true,
            clipboardData: dt
          });
          if (!pasteEvt.clipboardData || !pasteEvt.clipboardData.files || pasteEvt.clipboardData.files.length === 0) {
            try {
              Object.defineProperty(pasteEvt, 'clipboardData', {
                value: dt,
                writable: false,
                enumerable: true,
                configurable: true
              });
            } catch (_) {}
          }
          t.dispatchEvent(pasteEvt);
        } catch (e) {}
      }

      await sleep(700);
      if (hasGeminiUploadedPreview()) {
        await waitForGeminiImageUpload();
        return;
      }

      // FALLBACK 2: Drag & Drop Event
      reportProgress('2. Fallback: Thử nạp ảnh qua Drag & Drop Event...');
      for (const t of targets) {
        try {
          const opts = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt };
          for (const evtType of ['dragenter', 'dragover', 'drop']) {
            const evt = new DragEvent(evtType, opts);
            if (!evt.dataTransfer || !evt.dataTransfer.files || evt.dataTransfer.files.length === 0) {
              try {
                Object.defineProperty(evt, 'dataTransfer', { value: dt, configurable: true });
              } catch (_) {}
            }
            t.dispatchEvent(evt);
          }
        } catch (e) {}
      }

      await sleep(700);
      if (hasGeminiUploadedPreview()) {
        await waitForGeminiImageUpload();
        return;
      }

      // FALLBACK 3: Ghi System Clipboard + execCommand('paste') khi document thực sự focus
      try {
        window.focus();
        editor.focus();
      } catch (_) {}
      await sleep(150);

      if (document.hasFocus() && navigator.clipboard && navigator.clipboard.write) {
        reportProgress('3. Fallback: Document đang focus, nạp ảnh qua OS System Clipboard...');
        try {
          const firstImg = images[0];
          const res = await fetch(firstImg);
          const blob = await res.blob();
          let pngBlob = blob;
          if (blob.type !== 'image/png') {
            pngBlob = await new Promise((resolve) => {
              const img = new Image();
              img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || img.width;
                canvas.height = img.naturalHeight || img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                canvas.toBlob(resolve, 'image/png');
              };
              img.onerror = () => resolve(blob);
              img.src = firstImg;
            });
          }
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': pngBlob })
          ]);
          editor.focus();
          document.execCommand('paste');
          await sleep(700);
          if (hasGeminiUploadedPreview()) {
            await waitForGeminiImageUpload();
            return;
          }
        } catch (clipErr) {
          reportProgress(`Ghi OS clipboard không khả dụng (${clipErr.message}), chuyển sang File Input...`);
        }
      }

      // FALLBACK 4: Quét trực tiếp input[type="file"] trong DOM & Shadow DOM
      reportProgress('4. Fallback: Quét input[type="file"] trong DOM & Shadow DOM...');
      const fileInputs = findAllGeminiFileInputs();
      if (fileInputs.length > 0) {
        for (const input of fileInputs) {
          try {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
            if (descriptor && descriptor.set) {
              descriptor.set.call(input, dt.files);
            } else {
              input.files = dt.files;
            }
            input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          } catch (_) {}
        }
      }

      await waitForGeminiImageUpload();
    }

    // Ghi nhận phản hồi và số lượng câu hỏi trước đó để phân biệt câu trả lời mới
    const initialResponses = queryAllAny(SELECTORS.modelResponse);
    const initialCount = initialResponses.length;
    const initialLastText = initialCount > 0 ? extractGeminiMarkdown(initialResponses[initialCount - 1]) : '';
    const initialQueryCount = document.querySelectorAll('user-query').length;

    // 0.1. Nếu có hình ảnh đính kèm, tải ảnh lên trước khi điền văn bản
    if (Array.isArray(request.images) && request.images.length > 0) {
      await uploadImagesToGemini(editor, request.images);
    }

    // 1. Nhập prompt
    await enterTextIntoGemini(editor, request.prompt);

    // 2. Kích hoạt gửi câu hỏi với cơ chế kiểm tra đa tầng isSent (kèm số lượng user-query)
    await triggerSendGemini(editor, initialCount, initialQueryCount);

    // 2.1. Báo cho Background biết đã gửi câu hỏi thành công để nhả Input Mutex (chuyển giao cho provider khác nhập liệu)
    safeSendMessage({ action: 'INPUT_SUBMITTED', id: request.id, provider: 'gemini' });

    // 3. Theo dõi câu trả lời
    return await monitorGeminiResponse(request, initialCount, initialLastText, request.timeout || 180000);
  }

  // Chuỗi xử lý tuần tự (FIFO Chain) bảo đảm không bao giờ gọi đè hoặc spam tác vụ trên tab
  let executionChain = Promise.resolve();

  // 1. Gỡ bỏ listener cũ nếu có trên window để triệt tiêu hoàn toàn nguy cơ duplicate listener
  if (window.__GEMINI_BRIDGE_MSG_LISTENER__) {
    try {
      chrome.runtime.onMessage.removeListener(window.__GEMINI_BRIDGE_MSG_LISTENER__);
    } catch (_) {}
  }

  // 2. Cache các task ID đã và đang xử lý để loại trừ hoàn toàn việc chạy lặp
  const processedGeminiTasks = window.__GEMINI_PROCESSED_TASKS__ || new Set();
  window.__GEMINI_PROCESSED_TASKS__ = processedGeminiTasks;

  // Lắng nghe Message từ Background Service Worker
  const geminiMsgListener = (request, sender, sendResponse) => {
    if (request.action === 'PING' || request.action === 'CHECK_ACCOUNT') {
      reportGeminiAccount();
      sendResponse({ action: 'PONG', provider: 'gemini', version: SCRIPT_VERSION });
      return false;
    }

    if (request.action === 'GET_WEB_MODELS') {
      detectGeminiWebModels({ openMenu: Boolean(request.openMenu) })
        .then((result) => {
          safeSendMessage({ action: 'UPDATE_WEB_MODELS', provider: 'gemini', data: result });
          try { sendResponse(result); } catch (_) {}
        })
        .catch((err) => {
          try { sendResponse({ provider: 'gemini', currentModel: null, models: [], error: err.message }); } catch (_) {}
        });
      return true;
    }

    // Nhận lệnh hủy từ server/background
    if (request.action === 'CANCEL_TASK') {
      if (activeTaskId === request.id) {
        console.log(`🛑 [Gemini Bridge] Đã nhận lệnh CANCEL_TASK cho id: ${request.id}`);
        reportProgress(`Đã hủy tác vụ ${request.id}`);
        if (typeof activeReject === 'function') {
          activeReject(new Error(`Tác vụ ${request.id} đã bị hủy bởi hệ thống.`));
        }
        cleanupActiveTask();
      }
      return false;
    }

    if (request.action === 'ASK') {
      // Chống xử lý trùng lặp nếu message bị gửi lặp do bất kỳ nguyên nhân nào
      if (activeTaskId === request.id || processedGeminiTasks.has(request.id)) {
        console.log(`ℹ️ [Gemini Bridge] Task ${request.id} đã hoàn thành hoặc đang xử lý, bỏ qua duplicate message.`);
        return false;
      }
      processedGeminiTasks.add(request.id);
      if (processedGeminiTasks.size > 200) {
        const first = processedGeminiTasks.values().next().value;
        processedGeminiTasks.delete(first);
      }

      console.log('📥 [Gemini Bridge] Tiếp nhận yêu cầu ASK:', request.prompt?.slice(0, 50) + '... (ID: ' + request.id + ')');

      // Chèn vào hàng đợi tuần tự để xử lý từng lượt một, đợi lượt trước hoàn tất 100%
      executionChain = executionChain.then(async () => {
        isExecuting = true;
        activeTaskId = request.id;
        try {
          const answer = await handleGeminiAsk(request);
          safeSendMessage({
            action: 'TASK_RESULT',
            id: request.id,
            status: 'success',
            answer
          });
          try {
            sendResponse({ id: request.id, status: 'success', answer });
          } catch (_) {
            // Kênh sendResponse có thể đã đóng
          }
        } catch (err) {
          console.log('❌ [Gemini Bridge] Lỗi task ' + request.id + ':', err.message);
          safeSendMessage({
            action: 'TASK_RESULT',
            id: request.id,
            status: 'error',
            error: err.message
          });
          try {
            sendResponse({ id: request.id, status: 'error', error: err.message });
          } catch (_) {
            // Kênh sendResponse có thể đã đóng
          }
        } finally {
          cleanupActiveTask();
        }
      });

      return true; // Giữ async channel
    }
  };

  window.__GEMINI_BRIDGE_MSG_LISTENER__ = geminiMsgListener;
  chrome.runtime.onMessage.addListener(geminiMsgListener);

  // Floating Badge cho tab Gemini (Tuân thủ TrustedHTML, tái sử dụng UTILS)
  function injectGeminiBadge() {
    if (UTILS.injectFloatingBadge) {
      UTILS.injectFloatingBadge({
        id: 'gemini-bridge-floating-btn',
        labelText: 'Gemini Bridge',
        dotColor: '#38bdf8',
        badgeTitle: 'Bấm để mở Bridge Console (Ctrl+Shift+B)',
        logPrefix: '[Gemini Bridge]'
      });
      return;
    }

    if (document.getElementById('gemini-bridge-floating-btn')) return;
    const btn = document.createElement('div');
    btn.id = 'gemini-bridge-floating-btn';
    btn.textContent = 'Gemini Bridge';
    btn.onclick = () => safeSendMessage({ action: 'OPEN_SIDEPANEL' });
    document.body.appendChild(btn);
  }

  // Nhận diện tài khoản Google đang đăng nhập trên Gemini Web
  function detectGeminiAccount() {
    try {
      const selectors = [
        'a[aria-label*="@"]',
        'button[aria-label*="@"]',
        'a[aria-label*="Google Account"]',
        'a[aria-label*="Tài khoản Google"]',
        'a[href*="accounts.google.com"]',
        'img[alt*="@"]'
      ];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const text = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '';
          if (text) {
            const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
            if (emailMatch) {
              const email = emailMatch[1];
              let name = '';
              const nameMatch = text.match(/(?:Google Account|Tài khoản Google):\s*([^\n(]+)/i);
              if (nameMatch) {
                name = nameMatch[1].trim();
              } else {
                name = text.split('(')[0].replace(/(Google Account|Tài khoản Google):?/i, '').trim();
              }
              return { name: name || email.split('@')[0], email };
            }
          }
        }
      }
    } catch (e) {}
    return null;
  }

  function reportGeminiAccount() {
    const acc = detectGeminiAccount();
    if (acc) {
      console.log(`👤 [Gemini Bridge] Nhận diện tài khoản Gemini: ${acc.name} (${acc.email})`);
      safeSendMessage({
        action: 'UPDATE_ACCOUNT_INFO',
        provider: 'gemini',
        user: acc
      });
      return true;
    }
    return false;
  }

  // Quét danh sách Model thực tế từ giao diện Google Gemini Web
  async function detectGeminiWebModels({ openMenu = false } = {}) {
    const models = [];
    const seen = new Set();
    let currentModel = null;

    const findTriggerButton = () => {
      const prioritySelectors = [
        '[data-test-id="bard-mode-menu-button"]',
        'bard-mode-switcher button',
        '[data-test-id*="mode-menu" i]',
        '[data-test-id*="model-selector" i]'
      ];
      for (const sel of prioritySelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && isElementVisible(el)) return el;
        } catch (_) {}
      }

      const pill = document.querySelector('.logo-pill-label-container');
      if (pill) {
        const btn = pill.closest('button, [role="button"]') || pill;
        if (isElementVisible(btn)) return btn;
      }

      const keywords = ['2.5 flash', '2.5 pro', '2.0 flash', '1.5 pro', '1.5 flash', 'flash', 'pro', 'deep research', 'thinking', 'reasoning', 'personalization'];
      const candidateBtns = Array.from(document.querySelectorAll('header button, top-bar-actions button, bard-mode-switcher button, input-area-v2 button, .input-area-container button, button[aria-haspopup="menu"]'));
      for (const btn of candidateBtns) {
        if (!isElementVisible(btn)) continue;
        const text = (btn.innerText || btn.textContent || '').trim();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const lower = text.toLowerCase();
        if (!text || text.length > 50) continue;
        if (lower.includes('upgrade') || lower.includes('nâng cấp') || lower.includes('subscribe') || aria.includes('account') || aria.includes('tài khoản')) continue;
        if (keywords.some((kw) => lower.includes(kw) || aria.includes(kw))) {
          return btn;
        }
      }
      return null;
    };

    const normalizeSlug = (title) => {
      const slug = String(title || '').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
      if (!slug) return '';
      return slug.startsWith('gemini') ? slug : `gemini-${slug}`;
    };

    const triggerBtn = findTriggerButton();
    if (triggerBtn) {
      const lines = (triggerBtn.innerText || triggerBtn.textContent || '').split('\n').map(s => s.trim()).filter(Boolean);
      const filteredLines = lines.filter(l => !/^(gemini|keyboard_arrow_down|arrow_drop_down|expand_more)$/i.test(l));
      currentModel = filteredLines[0] || lines[0] || null;
      if (currentModel && currentModel.toLowerCase() === 'gemini') {
        currentModel = null;
      }
    }

    if (openMenu && triggerBtn && !isExecuting) {
      try {
        triggerBtn.click();
        await sleep(450);

        const overlayRoot = document.querySelector('.cdk-overlay-container') || document;
        const itemSelectors = [
          '[role="menuitem"]',
          '[role="menuitemradio"]',
          '.mat-mdc-menu-item',
          'button.bard-mode-list-button',
          '[data-test-id*="mode" i]'
        ];
        const rawItems = [];
        for (const sel of itemSelectors) {
          try {
            overlayRoot.querySelectorAll(sel).forEach(el => rawItems.push(el));
          } catch (_) {}
        }

        for (const item of rawItems) {
          if (!isElementVisible(item)) continue;
          const titleEl = item.querySelector('.mode-title, .title, [class*="mode-title"], [class*="title"]');
          const descEl = item.querySelector('.mode-desc, .subtitle, .description, [class*="desc"], [class*="subtitle"]');
          const lines = (item.innerText || item.textContent || '')
            .split('\n')
            .map(s => s.trim())
            .filter(s => s && !/^(check|done|new|mới|upgrade|nâng cấp)$/i.test(s));

          const title = (titleEl ? (titleEl.innerText || titleEl.textContent || '').trim() : '') || lines[0] || '';
          if (!title || title.length > 60) continue;

          const description = (descEl ? (descEl.innerText || descEl.textContent || '').trim() : '') || (lines.length > 1 ? lines.slice(1).join(' — ') : '');
          const id = normalizeSlug(title);
          if (!id || seen.has(id)) continue;
          seen.add(id);

          const hasCheckIcon = Boolean(item.querySelector('mat-icon[fonticon="check"], mat-icon[data-mat-icon-name="check"], [aria-label*="selected" i]'));
          const isSelected = item.getAttribute('aria-checked') === 'true' ||
                             item.classList.contains('is-selected') ||
                             item.classList.contains('selected') ||
                             hasCheckIcon ||
                             (currentModel && title.toLowerCase() === currentModel.toLowerCase());

          if (isSelected && !currentModel) {
            currentModel = title;
          }

          models.push({
            id,
            name: title,
            description,
            active: Boolean(isSelected),
            source: 'web-dom'
          });
        }
      } catch (_) {} finally {
        try {
          const backdrop = document.querySelector('.cdk-overlay-backdrop');
          if (backdrop) backdrop.click();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
        } catch (_) {}
      }
    }

    if (models.length === 0 && currentModel) {
      const id = normalizeSlug(currentModel);
      if (id) {
        models.push({
          id,
          name: currentModel,
          description: 'Active model on tab',
          active: true,
          source: 'web-trigger'
        });
      }
    }

    return {
      provider: 'gemini',
      currentModel,
      models,
      updatedAt: new Date().toISOString()
    };
  }

  function reportGeminiWebModels() {
    detectGeminiWebModels({ openMenu: false }).then((res) => {
      if (res && (res.currentModel || res.models.length > 0)) {
        safeSendMessage({ action: 'UPDATE_WEB_MODELS', provider: 'gemini', data: res });
      }
    }).catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      injectGeminiBadge();
      setTimeout(reportGeminiAccount, 1200);
      setTimeout(reportGeminiAccount, 4000);
      setTimeout(reportGeminiWebModels, 1500);
      setTimeout(reportGeminiWebModels, 4500);
    });
  } else {
    injectGeminiBadge();
    setTimeout(reportGeminiAccount, 1200);
    setTimeout(reportGeminiAccount, 4000);
    setTimeout(reportGeminiWebModels, 1500);
    setTimeout(reportGeminiWebModels, 4500);
  }
})();
