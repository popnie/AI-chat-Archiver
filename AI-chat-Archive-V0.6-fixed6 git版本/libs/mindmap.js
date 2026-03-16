(() => {
  function htmlToMarkdown(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const root = doc.querySelector('.markdown.prose') || doc.body;
    if (!root) return '# No content found';

    let out = '';

    function inlineText(fragmentHtml) {
      const wrap = doc.createElement('div');
      wrap.innerHTML = String(fragmentHtml || '')
        .replace(/<em>(.*?)<\/em>/gi, '*$1*')
        .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
        .replace(/<code>(.*?)<\/code>/gi, '`$1`');
      return (wrap.textContent || '').trim();
    }

    function walk(node) {
      if (!node) return;
      if (node.nodeType === Node.COMMENT_NODE) return;

      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent || '').trim();
        if (text) out += text;
        return;
      }

      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      switch (tag) {
        case 'h1':
          out += `\n# ${(node.textContent || '').trim()}\n\n`;
          return;
        case 'h2':
          out += `\n## ${(node.textContent || '').trim()}\n\n`;
          return;
        case 'h3':
          out += `\n### ${(node.textContent || '').trim()}\n\n`;
          return;
        case 'h4':
          out += `\n#### ${(node.textContent || '').trim()}\n\n`;
          return;
        case 'p': {
          const code = node.querySelector('code');
          if (code && (node.textContent || '').trim() === (code.textContent || '').trim()) {
            out += `\`${(code.textContent || '').trim()}\``;
          } else {
            const text = inlineText(node.innerHTML);
            if (text) out += `${text}\n\n`;
          }
          return;
        }
        case 'pre': {
          const code = node.querySelector('code');
          const lang = code?.className?.replace('language-', '') || '';
          const codeText = (code?.textContent || node.textContent || '').trim();
          out += `\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`;
          return;
        }
        case 'ul':
        case 'ol': {
          const isOrdered = tag === 'ol';
          const items = Array.from(node.children).filter((child) => child.tagName && child.tagName.toLowerCase() === 'li');
          items.forEach((li, index) => {
            const text = inlineText(li.innerHTML);
            if (!text) return;
            const bullet = isOrdered ? `${index + 1}.` : '*';
            out += `${bullet} ${text}\n`;
          });
          out += '\n';
          return;
        }
        case 'hr':
          out += '---\n\n';
          return;
        case 'table': {
          const rows = Array.from(node.querySelectorAll('tr'));
          if (!rows.length) return;
          const headerCells = Array.from(rows[0].querySelectorAll('th,td')).map((cell) => inlineText(cell.innerHTML));
          if (headerCells.length) {
            out += `| ${headerCells.join(' | ')} |\n`;
            out += `| ${headerCells.map(() => '---').join(' | ')} |\n`;
          }
          rows.slice(1).forEach((row) => {
            const cells = Array.from(row.querySelectorAll('td,th')).map((cell) => inlineText(cell.innerHTML));
            if (cells.length) out += `| ${cells.join(' | ')} |\n`;
          });
          out += '\n';
          return;
        }
        default:
          Array.from(node.childNodes || []).forEach(walk);
      }
    }

    Array.from(root.childNodes || []).forEach(walk);
    return out.trim() || '# No content found';
  }

  function parseScaleFromTransform(value) {
    if (!value || typeof value !== 'string') return null;
    const match = value.match(/scale\(([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\)/);
    if (!match) return null;
    const scale = Number(match[1]);
    return Number.isFinite(scale) ? scale : null;
  }

  function logRenderMetrics(popup, svg, meta = {}) {
    try {
      const popupRect = popup.getBoundingClientRect();
      const transform = (svg.querySelector('.markmap g') || svg.querySelector('g'))?.getAttribute('transform') || '';
      const foreign = svg.querySelector('.markmap-foreign div') || svg.querySelector('.markmap-foreign');
      const fontSize = foreign ? window.getComputedStyle(foreign).fontSize : 'not-found';
      const lineHeight = foreign ? window.getComputedStyle(foreign).lineHeight : 'not-found';
      const scale = parseScaleFromTransform(transform);
      console.info('[Mindmap][RenderMetrics]', {
        popupWidth: Math.round(popupRect.width),
        popupHeight: Math.round(popupRect.height),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        computedNodeFontSize: fontSize,
        computedNodeLineHeight: lineHeight,
        markmapScale: scale ?? 'not-found',
        fitApplied: meta?.fit?.fitApplied ?? 'unknown',
        preventedDownscale: meta?.fit?.preventedDownscale ?? 'unknown',
        fitScaleEstimate: meta?.fit?.fitScaleEstimate ?? 'unknown',
        fitAppliedScale: meta?.fit?.appliedScale ?? 'unknown',
        autoSizeWidth: meta?.autoSize?.targetWidth ?? 'unknown',
        autoSizeHeight: meta?.autoSize?.targetHeight ?? 'unknown',
        nodeMaxWidth: meta?.nodeMaxWidth ?? 'unknown'
      });
    } catch (err) {
      console.debug('[Mindmap][RenderMetrics] logging failed', err);
    }
  }

  function isDarkTheme() {
    try {
      if (typeof window.__acnIsDarkTheme === 'function') return !!window.__acnIsDarkTheme();
    } catch (_) {}
    return !!window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
  }

  function ensureMindmapExtraStyles() {
    if (document.getElementById('acn-mindmap-extra-styles')) return;
    const style = document.createElement('style');
    style.id = 'acn-mindmap-extra-styles';
    style.textContent = `
      .mindmap-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        box-sizing: border-box;
        overflow: hidden;
      }
      .mindmap-header .mindmap-title {
        flex: 1 1 auto;
        min-width: 0;
        display: block;
        text-align: left;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        padding: 0 0 0 8px;
        box-sizing: border-box;
      }
      .mindmap-header .mindmap-actions {
        flex: 0 1 auto;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: nowrap;
        overflow-x: auto;
        overflow-y: hidden;
        max-width: min(72vw, 760px);
        padding: 2px 2px 2px 0;
        scrollbar-width: thin;
      }
      .mindmap-header .mindmap-actions::-webkit-scrollbar {
        height: 6px;
      }
      .mindmap-header .mindmap-actions::-webkit-scrollbar-thumb {
        background: rgba(100,116,139,0.35);
        border-radius: 999px;
      }
      .mindmap-header .mindmap-export-btn,
      .mindmap-header .mindmap-close-btn {
        flex: 0 0 auto;
        border: 1px solid rgba(148,163,184,0.45);
        background: rgba(255,255,255,0.96);
        color: inherit;
        border-radius: 12px;
        height: 34px;
        min-width: 62px;
        padding: 0 14px;
        font-size: 13px;
        font-weight: 600;
        line-height: 32px;
        cursor: pointer;
        white-space: nowrap;
        opacity: 1;
        visibility: visible;
        transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease;
        position: static !important;
        right: auto !important;
        top: auto !important;
      }
      .mindmap-header .mindmap-export-btn:hover,
      .mindmap-header .mindmap-close-btn:hover {
        transform: translateY(-1px);
        background: #ffffff;
        border-color: rgba(100,116,139,0.55);
      }
      .mindmap-header .mindmap-close-btn {
        min-width: 40px;
        width: 40px;
        padding: 0;
        font-size: 22px;
        line-height: 30px;
      }
      .mindmap-popup.acn-theme-dark .mindmap-header .mindmap-export-btn,
      .mindmap-popup.acn-theme-dark .mindmap-header .mindmap-close-btn {
        background: rgba(17,24,39,0.94);
        border-color: rgba(100,116,139,0.55);
        color: #fff;
      }
      .mindmap-popup.acn-theme-dark .mindmap-header .mindmap-export-btn:hover,
      .mindmap-popup.acn-theme-dark .mindmap-header .mindmap-close-btn:hover {
        background: rgba(31,41,55,1);
      }
      .mindmap-popup .mindmap-loading-error {
        color: #ef4444;
        white-space: pre-wrap;
      }
      @media (max-width: 900px) {
        .mindmap-header {
          align-items: flex-start;
        }
        .mindmap-header .mindmap-title {
          padding-top: 6px;
        }
        .mindmap-header .mindmap-actions {
          max-width: 58vw;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function escapeXml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function sanitizeFilename(value) {
    const text = String(value || 'mindmap').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');
    return text || 'mindmap';
  }

  function buildExportBaseName(question, index) {
    const base = String(question || '').trim() || `Mindmap_Response_${index}`;
    return sanitizeFilename(base.slice(0, 80));
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function downloadText(filename, content, mimeType) {
    downloadBlob(filename, new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' }));
  }

  function markdownToTree(markdown, rootTitle) {
    const root = { text: rootTitle || 'Mindmap', children: [] };
    const stack = [{ level: 0, node: root }];
    let currentHeadingLevel = 1;

    String(markdown || '').split(/\r?\n/).forEach((line) => {
      const raw = String(line || '');
      const trimmed = raw.trim();
      if (!trimmed) return;

      let level = 0;
      let text = '';

      let match = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (match) {
        level = match[1].length;
        text = match[2].trim();
        currentHeadingLevel = level;
      } else {
        match = raw.match(/^(\s*)([-*+] |\d+\. )(.*)$/);
        if (match) {
          const indent = (match[1] || '').replace(/\t/g, '    ').length;
          level = currentHeadingLevel + 1 + Math.floor(indent / 2);
          text = match[3].trim();
        } else {
          level = currentHeadingLevel + 1;
          text = trimmed;
        }
      }

      if (!text) return;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const node = { text, children: [] };
      stack[stack.length - 1].node.children.push(node);
      stack.push({ level, node });
    });

    return root;
  }

  function renderOpmlNode(node, indent) {
    if (!node.children?.length) return `${indent}<outline text="${escapeXml(node.text)}"/>`;
    const children = node.children.map((child) => renderOpmlNode(child, `${indent}  `)).join('\n');
    return `${indent}<outline text="${escapeXml(node.text)}">\n${children}\n${indent}</outline>`;
  }

  function markdownToOpml(markdown, rootTitle) {
    const tree = markdownToTree(markdown, rootTitle);
    const body = tree.children.map((child) => renderOpmlNode(child, '    ')).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>${escapeXml(rootTitle || 'Mindmap')}</title>\n  </head>\n  <body>\n${body}\n  </body>\n</opml>`;
  }

  function renderFreeMindNode(node, indent) {
    if (!node.children?.length) return `${indent}<node TEXT="${escapeXml(node.text)}" />`;
    const children = node.children.map((child) => renderFreeMindNode(child, `${indent}  `)).join('\n');
    return `${indent}<node TEXT="${escapeXml(node.text)}">\n${children}\n${indent}</node>`;
  }

  function markdownToFreeMindXml(markdown, rootTitle) {
    const tree = markdownToTree(markdown, rootTitle);
    const body = tree.children.map((child) => renderFreeMindNode(child, '    ')).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<map version="1.0.1">\n  <node TEXT="${escapeXml(rootTitle || 'Mindmap')}">\n${body}\n  </node>\n</map>`;
  }

  function buildStandaloneHtml(title, svgMarkup, darkMode) {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeXml(title || 'Mindmap')}</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: ${darkMode ? '#111827' : '#f3f4f6'};
      color: ${darkMode ? '#f9fafb' : '#111827'};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .page {
      min-height: 100vh;
      box-sizing: border-box;
      padding: 24px;
      display: flex;
      justify-content: center;
      align-items: flex-start;
    }
    .card {
      background: ${darkMode ? '#1f2937' : '#ffffff'};
      border-radius: 16px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.12);
      padding: 16px;
      overflow: auto;
      max-width: 100%;
    }
    svg {
      display: block;
      max-width: none;
      height: auto;
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="card">${svgMarkup}</div>
  </div>
</body>
</html>`;
  }

  function exportOpml(state) {
    downloadText(`${state.baseName}.opml`, markdownToOpml(state.markdown, state.exportTitle), 'text/xml;charset=utf-8');
  }

  function exportHtml(state) {
    const svgMarkup = new XMLSerializer().serializeToString(state.svg);
    const html = buildStandaloneHtml(state.exportTitle, svgMarkup, state.darkMode);
    downloadText(`${state.baseName}.html`, html, 'text/html;charset=utf-8');
  }

  function exportXml(state) {
    downloadText(`${state.baseName}.xml`, markdownToFreeMindXml(state.markdown, state.exportTitle), 'application/xml;charset=utf-8');
  }

  function exportPdf(state) {
    const svgMarkup = new XMLSerializer().serializeToString(state.svg);
    const html = buildStandaloneHtml(state.exportTitle, svgMarkup, state.darkMode).replace(
      '</body>',
      `<script>window.onload=function(){setTimeout(function(){window.print();},300);};<\\/script></body>`
    );
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (!win) {
      alert('PDF 导出窗口被浏览器拦截，请允许弹窗后重试。');
      URL.revokeObjectURL(url);
      return;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function destroyPopupWithMarkmap(popup) {
    const svg = popup.querySelector('#mindmap-svg');
    if (!svg?.dataset.mmId) {
      popup.remove();
      return;
    }
    function onDestroyed(event) {
      if (event.data?.type === 'DESTROY_MM_DONE' && event.data.mmId === svg.dataset.mmId) {
        window.removeEventListener('message', onDestroyed);
        popup.remove();
      }
    }
    window.addEventListener('message', onDestroyed);
    window.postMessage({ type: 'DESTROY_MM', mmId: svg.dataset.mmId }, '*');
  }

  function attachExportHandlers(popup, state) {
    const actions = popup.querySelector('.mindmap-actions');
    if (!actions) return;
    actions.addEventListener('click', (event) => {
      const button = event.target.closest('[data-export]');
      if (!button) return;
      const action = button.dataset.export;
      if (action === 'close') return destroyPopupWithMarkmap(popup);
      if (action === 'opml') return exportOpml(state);
      if (action === 'html') return exportHtml(state);
      if (action === 'xml') return exportXml(state);
      if (action === 'pdf') return exportPdf(state);
    });
  }

  async function generateMindmap(questionText, source, responseIndex, isMarkdown = false) {
    ensureMindmapExtraStyles();

    const popup = document.createElement('div');
    popup.id = `mindmap-${Date.now()}`;
    popup.className = 'mindmap-popup';
    const darkMode = isDarkTheme();
    if (darkMode) popup.classList.add('acn-theme-dark');

    popup.innerHTML = `
      <div class="mindmap-header">
        <span class="mindmap-title">Mindmap View of Response to Message ${responseIndex}</span>
        <div class="mindmap-actions">
          <button class="mindmap-export-btn" data-export="opml" title="导出 OPML">OPML</button>
          <button class="mindmap-export-btn" data-export="html" title="导出 HTML">HTML</button>
          <button class="mindmap-export-btn" data-export="xml" title="导出 XML">XML</button>
          <button class="mindmap-export-btn" data-export="pdf" title="导出 PDF">PDF</button>
          <button class="mindmap-close-btn" data-export="close" title="关闭">×</button>
        </div>
      </div>
      <div class="mindmap-content">
        <div id="mindmap-loading">Converting content → mind-map …</div>
        <svg id="mindmap-svg"></svg>
      </div>
      <div class="mindmap-resize-handle"></div>
    `;

    document.body.appendChild(popup);
    makePopupDraggable(popup);

    let maximized = false;
    let previousRect = null;
    let previousTransform = null;
    popup.querySelector('.mindmap-header').addEventListener('dblclick', (event) => {
      if (event.target.closest('.mindmap-actions')) return;
      if (maximized) {
        if (previousRect) {
          popup.style.left = previousRect.left;
          popup.style.top = previousRect.top;
          popup.style.width = previousRect.width;
          popup.style.height = previousRect.height;
          popup.style.position = previousRect.position;
          popup.style.zIndex = previousRect.zIndex;
        }
        popup.style.transform = previousTransform || 'translateX(-50%)';
        maximized = false;
        return;
      }
      previousRect = {
        left: popup.style.left,
        top: popup.style.top,
        width: popup.style.width,
        height: popup.style.height,
        position: popup.style.position,
        zIndex: popup.style.zIndex
      };
      previousTransform = popup.style.transform;
      popup.style.left = '0';
      popup.style.top = '0';
      popup.style.width = '100vw';
      popup.style.height = '100vh';
      popup.style.position = 'fixed';
      popup.style.zIndex = '2147483647';
      popup.style.transform = 'none';
      maximized = true;
    });

    const markdown = isMarkdown ? String(source || '') : htmlToMarkdown(source);
    const exportTitle = String(questionText || '').trim() || `Response ${responseIndex}`;
    const state = {
      markdown,
      questionText,
      responseIndex,
      darkMode,
      exportTitle,
      baseName: buildExportBaseName(questionText, responseIndex),
      popup,
      svg: popup.querySelector('#mindmap-svg')
    };
    attachExportHandlers(popup, state);

    const svg = state.svg;
    svg.id = `mm-${Date.now().toString(36)}`;
    svg.dataset.mmId = svg.id;
    svg.style.visibility = 'hidden';
    svg.style.display = 'block';

    await new Promise((resolve) => requestAnimationFrame(resolve));
    let { width, height } = svg.getBoundingClientRect();
    if (!width || !height) {
      width = 800;
      height = 600;
    }
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    const loading = popup.querySelector('#mindmap-loading');
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onRenderMessage);
      loading.classList.add('mindmap-loading-error');
      loading.textContent = 'Mindmap render timed out. Please retry.';
    }, 12000);

    function onRenderMessage(event) {
      if (!event.data || event.data.svgId !== svg.id) return;
      if (event.data.type === 'RENDER_MM_DONE') {
        if (done) return;
        done = true;
        clearTimeout(timer);
        loading.remove();
        svg.style.visibility = '';
        logRenderMetrics(popup, svg, event.data);
        window.removeEventListener('message', onRenderMessage);
        return;
      }
      if (event.data.type === 'RENDER_MM_ERROR') {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onRenderMessage);
        loading.classList.add('mindmap-loading-error');
        loading.textContent = `Mindmap render failed: ${event.data.error || 'Unknown error'}`;
      }
    }

    window.addEventListener('message', onRenderMessage);
    window.postMessage({ type: 'RENDER_MM', svgId: svg.id, markdown }, '*');
  }

  function makePopupDraggable(popup) {
    const header = popup.querySelector('.mindmap-header');
    const resizeHandle = popup.querySelector('.mindmap-resize-handle');
    let dragging = false;
    let resizing = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;

    header.addEventListener('mousedown', (event) => {
      if (event.target.closest('.mindmap-actions')) return;
      dragging = true;
      dragOffsetX = event.clientX - popup.offsetLeft;
      dragOffsetY = event.clientY - popup.offsetTop;
    });

    resizeHandle.addEventListener('mousedown', (event) => {
      resizing = true;
      startX = event.clientX;
      startY = event.clientY;
      startWidth = popup.offsetWidth;
      startHeight = popup.offsetHeight;
      event.stopPropagation();
    });

    document.addEventListener('mousemove', (event) => {
      if (dragging) {
        popup.style.left = `${event.clientX - dragOffsetX}px`;
        popup.style.top = `${event.clientY - dragOffsetY}px`;
        return;
      }
      if (resizing) {
        const nextWidth = Math.max(640, startWidth + (event.clientX - startX));
        const nextHeight = Math.max(420, startHeight + (event.clientY - startY));
        popup.style.width = `${nextWidth}px`;
        popup.style.height = `${nextHeight}px`;
      }
    });

    document.addEventListener('mouseup', () => {
      dragging = false;
      resizing = false;
    });
  }

  window.MindmapUtils = {
    htmlToMarkdown,
    generateMindmap,
    makePopupDraggable,
    markdownToOpml,
    markdownToFreeMindXml
  };
})();
