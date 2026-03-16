/*
 * Ultimate AI Universal Exporter & Backup
 */
(function () {
    "use strict";
    if (window.__gpt_universal_exporter) return;
    window.__gpt_universal_exporter = true;

    const isChatGPT = location.hostname.includes("chatgpt.com");

    const gpt_exportConfig = { baseDelay: 500, jitter: 300, pageLimit: 100 };
    let gpt_exportAccessToken = null;
    const gpt_capturedWorkspaceIds = new Set();

    if (isChatGPT) {
        const originalFetch = window.fetch;
        window.fetch = async function (resource, options) {
            gpt_tryCaptureToken(options?.headers);
            const accountId = options?.headers?.["ChatGPT-Account-Id"];
            if (accountId && !gpt_capturedWorkspaceIds.has(accountId)) gpt_capturedWorkspaceIds.add(accountId);
            return originalFetch.apply(this, arguments);
        };
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (...args) {
            this.addEventListener("readystatechange", () => {
                if (this.readyState === 4) {
                    try {
                        gpt_tryCaptureToken(this.getRequestHeader("Authorization"));
                        const accountId = this.getRequestHeader("ChatGPT-Account-Id");
                        if (accountId && !gpt_capturedWorkspaceIds.has(accountId)) gpt_capturedWorkspaceIds.add(accountId);
                    } catch (_) {}
                }
            });
            return originalOpen.apply(this, args);
        };
    }

    function gpt_tryCaptureToken(headerSource) {
        if (!headerSource) return;
        let headerValue = typeof headerSource === "string" ? headerSource : (headerSource instanceof Headers ? headerSource.get("Authorization") : (headerSource.Authorization || headerSource.authorization));
        if (headerValue?.startsWith("Bearer ")) {
            const token = headerValue.slice(7);
            if (token && token.toLowerCase() !== "dummy") gpt_exportAccessToken = token;
        }
    }

    async function gpt_ensureAccessToken() {
        if (gpt_exportAccessToken) return gpt_exportAccessToken;
        try {
            const response = await fetch("/api/auth/session?unstable_client=true");
            const session = await response.json();
            if (session.accessToken) return (gpt_exportAccessToken = session.accessToken);
        } catch (_) {}
        throw new Error("无法获取 Access Token，请刷新页面后重试。");
    }

    function gpt_getOaiDeviceId() {
        const match = document.cookie.match(/oai-did=([^;]+)/);
        return match ? match[1] : null;
    }

    function gpt_buildHeaders(workspaceId) {
        const deviceId = gpt_getOaiDeviceId();
        if (!deviceId) throw new Error("无法获取 oai-device-id，请确保已登录并刷新页面。");
        const headers = { Authorization: `Bearer ${gpt_exportAccessToken}`, "oai-device-id": deviceId };
        if (workspaceId) headers["ChatGPT-Account-Id"] = workspaceId;
        return headers;
    }

    const gpt_sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const gpt_getRandomDelay = () => gpt_exportConfig.baseDelay + Math.random() * gpt_exportConfig.jitter;
    const gpt_sanitizeFilename = (name) => name.replace(/[\/\\?%*:|"<>]/g, "-").trim();

    function gpt_detectAllWorkspaceIds() {
        const foundIds = new Set(gpt_capturedWorkspaceIds);
        try {
            const nextDataText = document.getElementById("__NEXT_DATA__")?.textContent;
            if (nextDataText) {
                const accounts = JSON.parse(nextDataText)?.props?.pageProps?.user?.accounts;
                if (accounts) Object.values(accounts).forEach(acc => { if (acc?.account?.id) foundIds.add(acc.account.id); });
            }
        } catch (_) {}
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.includes("account") || key.includes("workspace"))) {
                    const value = localStorage.getItem(key);
                    if (value && /ws-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(value)) {
                        foundIds.add(value.match(/ws-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i)[0]);
                    } else if (value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.replace(/"/g, ""))) {
                        foundIds.add(value.replace(/"/g, ""));
                    }
                }
            }
        } catch (_) {}
        return Array.from(foundIds);
    }

    function formatBytes(bytes, decimals = 2) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024, dm = decimals < 0 ? 0 : decimals;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    // ========== 解析对话主程序 ==========
// ========== 解析对话主程序 (修复排版和公式丢失问题) ==========
function parseChatGPTConversation(data) {
    const messages = [];
    let currentNode = data.current_node;
    const path = [];
    while(currentNode) { path.push(data.mapping[currentNode]); currentNode = data.mapping[currentNode].parent; }
    
    path.reverse().forEach(node => {
        const msg = node?.message;
        if (!msg) return;

        let textContent = "";
        let attachmentBlocks = [];
        const imageIds = new Set(); 

        // 解析附件图片，将 msg.id 嵌入 alt 属性，用作寻址追踪
        if (msg.metadata && msg.metadata.attachments) {
            msg.metadata.attachments.forEach(att => {
                const mime = att.mime_type || att.mimeType || "";
                if (mime.startsWith('image/')) {
                    if (att.id) {
                        const fileId = att.id.replace('file-service://', '');
                        imageIds.add(fileId);
                        attachmentBlocks.push(`\n![img_${msg.id}](file-service://${fileId})\n`);
                    }
                } else {
                    const attFileId = att.id ? att.id.replace('file-service://', '') : null;
                    let isImageInParts = false;
                    if (attFileId && msg.content && msg.content.parts) {
                        isImageInParts = msg.content.parts.some(p =>
                            p?.content_type === 'image_asset_pointer' &&
                            p.asset_pointer && p.asset_pointer.replace('file-service://', '') === attFileId
                        );
                    }
                    if (isImageInParts) {
                        imageIds.add(attFileId);
                        attachmentBlocks.push(`\n![img_${msg.id}](file-service://${attFileId})\n`);
                    } else {
                        const name = att.name || "文件附件";
                        const size = att.size ? formatBytes(att.size) : "";
                        attachmentBlocks.push(`\n[attachment:${name}|${size}]\n`);
                    }
                }
            });
        }

        // 解析正文图片和工具消息
        if (msg.content && msg.content.parts) {
            const parts = msg.content.parts.map(p => {
                // 【核心修复】：直接返回原生文本，不再进行过度清洗，防止破坏数学公式和代码排版！
                if (typeof p === 'string') return p;
                
                if (p?.content_type === 'image_url' && p.image_url?.url) return `\n![img_${msg.id}](${p.image_url.url})\n`;
                if (p?.content_type === 'image_asset_pointer' && p.asset_pointer) {
                    const fileId = p.asset_pointer.replace('file-service://', '');
                    if (!imageIds.has(fileId)) {
                        imageIds.add(fileId);
                        return `\n![img_${msg.id}](file-service://${fileId})\n`;
                    }
                }
                return ``;
            });
            textContent = parts.join("\n");
        }

        const fullText = attachmentBlocks.join("") + textContent;
        if(fullText.trim()) {
            // 【核心修复】：还原原本的 role 判断，确保不遗漏带有公式的子消息
            messages.push({ role: msg.author?.role === "user" ? "You" : "ChatGPT", content: fullText.trim() });
        }
    });
    return { title: data.title || "ChatGPT_Chat", messages };
}
    
    
    
    
    

    function markdownToHTML(text) {
        let html = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        
        html = html.replace(/\[attachment:(.*?)\|(.*?)\]/g, (match, name, size) => {
            return `<div class="file-attachment"><div class="file-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg></div><div class="file-info"><div class="file-name">${name}</div><div class="file-size">${size}</div></div></div>`;
        });

        html = html.replace(/```([\w-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
            return `<div class="code-block"><div class="code-header"><span>${lang || 'code'}</span></div><pre><code>${code}</code></pre></div>`;
        });
        
        html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
        // 核心修复2：移除 crossorigin="anonymous"，允许原生免验证加载
        html = html.replace(/!\[([^\]]*)\]\((.*?)\)/g, '<img src="$2" alt="$1" />');
        html = html.replace(/(^|[^!])\[([^\]]+)\]\((.*?)\)/g, '$1<a href="$3" target="_blank">$2</a>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
        html = html.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');

        html = html.replace(/((\|.*\|(?:[\r\n]+|$))+)/g, (match) => {
            if(!match.includes('-|-') && !match.match(/\|[-:\s]+\|/)) return match; 
            const rows = match.trim().split('\n');
            let table = `<table class="chat-table"><thead>`;
            let isBody = false;
            rows.forEach((row, i) => {
                // 精准识别 Markdown 表格的分隔行 (如 |---|---|)
                if (row.match(/^\|?[-:\s|]+\|?$/)) { 
                    isBody = true; 
                    table += `</thead><tbody>`; 
                    return; 
                }
                const cells = row.split('|').map(c => c.trim());
                if (cells[0] === '') cells.shift();
                if (cells[cells.length - 1] === '') cells.pop();
                if (cells.length === 0) return;
                
                table += `<tr>`;
                cells.forEach(cell => {
                    table += isBody ? `<td>${cell}</td>` : `<th>${cell}</th>`;
                });
                table += `</tr>`;
            });
            if(!isBody) table += `</thead><tbody>`;
            table += `</tbody></table>`;
            return table;
        });
        
        html = html.split(/\n\n+/).map(p => {
            if(p.trim().startsWith('<div') || p.trim().startsWith('<h') || p.trim().startsWith('<blockquote') || p.trim().startsWith('<table')) return p;
            return `<p>${p.replace(/\n/g, '<br/>')}</p>`;
        }).join('');
        // 【新增】保护数学公式块内的换行符，防止被错误渲染
        html = html.replace(/\\\[([\s\S]*?)\\\]/g, match => match.replace(/<br\/>/g, '\n'));
        html = html.replace(/\$\$([\s\S]*?)\$\$/g, match => match.replace(/<br\/>/g, '\n'));
        return html;
    }

    const buildHTML = (data) => {
        let html = `<!DOCTYPE html><html><head><meta charset="utf-8">
        <title>${data.title}</title>
        <script>
            window.MathJax = {
                tex: {
                    inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
                    displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']],
                    processEscapes: true
                },
                options: {
                    skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
                }
            };
        </script>
        <script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js" id="MathJax-script"></script>
        <style>
            /* 【新增】防止过长的数学公式撑爆页面 */
            .mjx-chtml { max-width: 100%; overflow-x: auto; overflow-y: hidden; }
            
            /* 现有的 CSS 继续保留... */
            :root {
                --text-primary: #24292f;
                --bg-main: #ffffff;
                --bg-user: #f3f4f6;
                --bg-code: #1f2328;
                --text-code: #e6edf3;
                --border-color: #d0d7de;
                --link-color: #0969da;
            }
            body { 
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"; 
                color: var(--text-primary); 
                background: var(--bg-main); 
                margin: 0; 
                line-height: 1.6; 
                font-size: 15px; 
                word-wrap: break-word; 
                -webkit-font-smoothing: antialiased;
            }
            .chat-container { max-width: 850px; margin: 0 auto; padding: 40px 30px; display: flex; flex-direction: column; gap: 32px; }
            h1.doc-title { text-align: center; border-bottom: 2px solid var(--border-color); padding-bottom: 20px; margin-bottom: 40px; font-size: 28px; color: #111; font-weight: 700; }
            
            .message-row { display: flex; width: 100%; gap: 16px; }
            .message-row.You { justify-content: flex-end; }
            .message-row.AI { justify-content: flex-start; }
            
            .avatar { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid var(--border-color); background: #fff; margin-top: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
            .You .avatar { display: none; }
            
            .message-bubble { max-width: 100%; }
            .You .message-bubble { background: var(--bg-user); padding: 14px 20px; border-radius: 20px; border-bottom-right-radius: 4px; max-width: 80%; font-size: 15px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
            .AI .message-bubble { width: calc(100% - 48px); padding-top: 6px; }
            
            h1, h2, h3, h4, h5, h6 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25; }
            h1 { font-size: 2em; border-bottom: 1px solid var(--border-color); padding-bottom: .3em; }
            h2 { font-size: 1.5em; border-bottom: 1px solid var(--border-color); padding-bottom: .3em; }
            h3 { font-size: 1.25em; }
            
            .code-block { background: var(--bg-code); border-radius: 8px; margin: 16px 0; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            .code-header { background: #30363d; color: #8b949e; padding: 8px 16px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; border-bottom: 1px solid #484f58; }
            .code-block pre { margin: 0; padding: 16px; overflow-x: auto; }
            .code-block code { color: var(--text-code); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13.5px; background: transparent; padding: 0; line-height: 1.45; }
            
            :not(pre) > code { background: rgba(175, 184, 193, 0.2); padding: 0.2em 0.4em; border-radius: 6px; font-size: 85%; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: #24292f; }
            
            p { margin-top: 0; margin-bottom: 16px; }
            p:last-child { margin-bottom: 0; }
            a { color: var(--link-color); text-decoration: none; font-weight: 500; }
            a:hover { text-decoration: underline; }
            
            img { max-width: 100%; border-radius: 8px; border: 1px solid var(--border-color); display: block; margin: 16px 0; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
            
            blockquote { margin: 0 0 16px 0; padding: 0 1em; color: #57606a; border-left: 0.25em solid #d0d7de; }
            
            .chat-table { border-collapse: separate; border-spacing: 0; width: 100%; margin: 16px 0; font-size: 14px; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
            .chat-table thead { background: #f9fafb; }
            .chat-table th, .chat-table td { padding: 10px 16px; text-align: left; border-right: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color); }
            .chat-table th:last-child, .chat-table td:last-child { border-right: none; }
            .chat-table tbody tr:last-child td { border-bottom: none; }
            .chat-table tbody tr:nth-child(2n) { background-color: #f6f8fa; }
            .chat-table th { font-weight: 600; color: #1f2328; border-bottom: 2px solid #d0d7de; }

            .file-attachment { display: inline-flex; align-items: center; background: var(--bg-main); border: 1px solid var(--border-color); border-radius: 12px; padding: 12px 16px; margin: 8px 0; max-width: 320px; gap: 14px; box-shadow: 0 2px 6px rgba(0,0,0,0.04); }
            .You .file-attachment { background: #ffffff; border-color: #d1d5db; }
            .file-icon { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; background: #eef2ff; color: #4f46e5; border-radius: 10px; flex-shrink: 0; }
            .You .file-icon { background: #f3f4f6; color: #3b82f6; }
            .file-info { display: flex; flex-direction: column; overflow: hidden; }
            .file-name { font-size: 14px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3; margin-bottom: 3px;}
            .file-size { font-size: 12.5px; color: #57606a; line-height: 1.2;}
        </style></head><body>
        <div class="chat-container">
            <h1 class="doc-title">${data.title}</h1>`;
        
        const aiSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M22.28 9.82a5.98 5.98 0 0 0-.51-4.91 6.04 6.04 0 0 0-6.51-2.9A6.06 6.06 0 0 0 4.98 4.18a5.98 5.98 0 0 0-4 2.9 6.04 6.04 0 0 0 .74 7.09 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.51 2.9A5.98 5.98 0 0 0 13.26 24a6.05 6.05 0 0 0 5.77-4.2 5.98 5.98 0 0 0 4-2.9 6.05 6.05 0 0 0-.75-7.08zm-9.02 12.6a4.47 4.47 0 0 1-2.87-1.04l.14-.08 4.77-2.75a.79.79 0 0 0 .39-.68v-6.73l2.02 1.16c.01.02.03.04.03.05v5.58a4.5 4.5 0 0 1-4.49 4.49zm-9.66-4.12a4.47 4.47 0 0 1-.53-3.01l.14.08 4.78 2.75c.23.13.53.13.78 0l5.84-3.36v2.33c0 .02-.01.04-.03.06L9.74 19.95a4.49 4.49 0 0 1-6.14-1.64zM2.34 7.89a4.48 4.48 0 0 1 2.36-1.97V11.6c0 .28.14.53.38.67l5.81 3.35-2.02 1.16a.07.07 0 0 1-.07 0l-4.83-2.78A4.5 4.5 0 0 1 2.34 7.89zm16.09 3.85L12.59 8.38a.07.07 0 0 1 0-.11l4.83-2.78a4.49 4.49 0 0 1 2.14 5.76l-.14-.08-4.78-2.75a.78.78 0 0 0-.78 0l-5.84 3.36v-2.33l5.84-3.36c.02 0 .04 0 .07 0l4.83 2.78a4.5 4.5 0 0 1-2.33 8.16V11.75z" fill="#000000"/></svg>`;

        data.messages.forEach(m => {
            const isYou = m.role === "You";
            const rowClass = isYou ? "You" : "AI";
            const safeContent = markdownToHTML(m.content);
            html += `<div class="message-row ${rowClass}"><div class="avatar">${!isYou ? aiSvg : ''}</div><div class="message-bubble">${safeContent}</div></div>`;
        });
        return html + `</div></body></html>`;
    };

    const downloadBlob = (content, type, filename) => {
        const blob = new Blob([content], { type });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    };
  
   // ========== 真正的终极图片处理引擎：呼叫 Background 越权下载 ==========
    // ========== 终极图片通信引擎：安全呼叫 Background ==========
    async function fetchImageAsBase64(url, token) {
        return new Promise((resolve) => {
            try {
                if (!url || url.startsWith("data:")) {
                    return resolve(url);
                }
                chrome.runtime.sendMessage({ action: "fetchImageBase64", url: url, token: token }, (response) => {
                    // 拦截各种通信断开的错误，防止控制台爆黄
                    if (chrome.runtime.lastError) {
                        resolve(null);
                    } else if (response && response.base64) {
                        resolve(response.base64);
                    } else {
                        resolve(null);
                    }
                });
            } catch (e) {
                resolve(null);
            }
        });
    }


// ====== [新增] 从当前页面 DOM 里解析真实图片 URL（AIexporter 同款思路）======
// ====== [新增] 从当前页面 DOM 里解析真实图片 URL（升级版：支持精确识别AI生成的图片）======
function resolveRealImageUrlFromDOM(fileIdOrToken, msgId) {
  try {
    const token = String(fileIdOrToken || "").replace(/^file_/, "");
    
    // 1. 精确匹配：利用 msgId 寻找对应的聊天气泡，提取里面的 blob: 图片 (专门对付 DALL-E 和 Python 图表)
    if (msgId) {
      const imgsInMsg = document.querySelectorAll(`[data-message-id="${msgId}"] img`);
      for (const img of imgsInMsg) {
        const url = img.currentSrc || img.src || img.getAttribute("src");
        if (url && url.startsWith("blob:")) return url; 
      }
    }

    // 2. 模糊匹配：利用 token 寻找用户上传的普通图片
    if (token) {
      const selectors = [
        `img[src*="${token}"]`,
        `img[srcset*="${token}"]`,
        `img[data-src*="${token}"]`,
        `img[data-testid*="${token}"]`
      ];
      for (const sel of selectors) {
        const img = document.querySelector(sel);
        if (img) {
          const url = img.currentSrc || img.src || img.getAttribute("src") || "";
          if (url) return url;
        }
      }
    }
    
    // 3. 终极兜底：如果前两者都失败，且知道是哪个消息，就抓取该消息里的第一张图
    if (msgId) {
      const imgInMsg = document.querySelector(`[data-message-id="${msgId}"] img`);
      if (imgInMsg) {
         return imgInMsg.currentSrc || imgInMsg.src || imgInMsg.getAttribute("src");
      }
    }
  } catch (_) {}
  return "";
}

// ====== [新增] 在页面上下文把 blob: 图片转成 dataURL（background 抓不到 blob:）======
// ====== [新增] 全平台终极图片获取引擎：三重降级策略 ======
async function forceGetBase64(url, token) {
    if (!url || url.startsWith("data:")) return url;
    
    // 策略 0：专门针对 Claude 和 Gemini 的 blob: / googleusercontent 链接 (不屏蔽身份验证)
    if (url.startsWith("blob:") || url.includes("googleusercontent")) {
        try {
            const res = await fetch(url);
            const blob = await res.blob();
            return await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
            });
        } catch(e) {}
    }

    // 策略 1：当前页面原生拉取 (屏蔽凭证以防跨域报错)
    try {
        const res = await fetch(url, { credentials: 'omit' });
        const blob = await res.blob();
        const dataUrl = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
        });
        if (dataUrl) return dataUrl;
    } catch(e) {}

    // 策略 2：Background 后台越权拉取 
    try {
        const bgBase64 = await fetchImageAsBase64(url, token);
        if (bgBase64) return bgBase64;
    } catch(e) {}

    // 策略 3：Canvas 暴力截取
    try {
        return await new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
                const canvas = document.createElement("canvas");
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0);
                resolve(canvas.toDataURL("image/png"));
            };
            img.onerror = () => resolve(null);
            img.src = url;
        });
    } catch(e) {
        return null;
    }
}

// ========== 图片地址批量解析器（终极升级版：解决 DALL-E 和 Python 图表丢失问题） ==========
// ========== 批量图片解析器（三平台通用融合版） ==========
async function resolveImagesToBase64(rawHtml) {
    let token = null;
    try { token = await gpt_ensureAccessToken(); } catch (e) {}

    const replaceMap = {};
    const promises = [];

    // 匹配 HTML 里所有的 <img> 标签
    const imgTagRegex = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = imgTagRegex.exec(rawHtml)) !== null) {
        const originalTag = match[0];
        const srcUrl = match[1];
        
        // 提取我们在底层打上的追踪信标 alt="img_XXX"
        let msgId = "";
        const altMatch = originalTag.match(/alt=["']img_([^"']+)["']/i);
        if (altMatch) msgId = altMatch[1];

        if (srcUrl.startsWith("data:image/")) continue;
        if (replaceMap[srcUrl]) continue;

        promises.push((async () => {
            let realUrl = "";
            
            // 如果是 ChatGPT 的内部链接
            if (srcUrl.startsWith("file-service://") || srcUrl.startsWith("sediment://")) {
                const fileId = srcUrl.split("://").pop().replace(/^file_/, "");
                realUrl = resolveRealImageUrlFromDOM(fileId, msgId);
                
                if (!realUrl && token) {
                    try {
                        const dlRes = await fetch(`/backend-api/files/${fileId}/download`, { headers: { 'Authorization': `Bearer ${token}` } });
                        const dlJson = await dlRes.json();
                        if (dlJson?.download_url) realUrl = dlJson.download_url;
                    } catch (_) {}
                }
            } else {
                // 普通链接（Claude 和 Gemini 直接走这里）
                realUrl = resolveRealImageUrlFromDOM("", msgId) || srcUrl;
            }

            if (!realUrl) return;

            // 🔥 呼叫统一引擎，强行将图片转换为 Base64
            const base64 = await forceGetBase64(realUrl, token);
            if (base64) replaceMap[srcUrl] = base64;
            else replaceMap[srcUrl] = realUrl;
        })());
    }

    await Promise.all(promises);

    // 全局替换 HTML
    for (const [originalSrc, replacement] of Object.entries(replaceMap)) {
        if (!replacement) continue;
        rawHtml = rawHtml.split(`src="${originalSrc}"`).join(`src="${replacement}"`);
        rawHtml = rawHtml.split(`src='${originalSrc}'`).join(`src='${replacement}'`);
    }

    return rawHtml;
}
    
    

    const Formatters = {
        md: (data) => `# ${data.title}\n\n` + data.messages.map(m => `**${m.role}**:\n${m.content}\n\n`).join('---\n\n'),
        txt: (data) => `[ 标题: ${data.title} ]\n\n` + data.messages.map(m => `【${m.role}】:\n${m.content}\n\n`).join('==============================\n\n'),
        
        exportPDF: async (data, btn, originalHtml) => {
            try {
                btn.innerHTML = `<div style="font-size:20px; margin-bottom:8px;">⏳</div><div style="font-size:12px;">生成完美排版...</div>`;
                let rawHtml = buildHTML(data);
                
                // 等待所有图片转为 Base64 纯文本
                rawHtml = await resolveImagesToBase64(rawHtml);

                // 【核心突破】：注入“智能等待 MathJax 渲染完成后自动打印”的脚本
                const printHtml = rawHtml.replace('</body></html>', `
                <script>
                    window.addEventListener('load', () => {
                        let printed = false;
                        const doPrint = () => { 
                            if (!printed) { 
                                printed = true; 
                                setTimeout(() => window.print(), 800); 
                            } 
                        };
                        const checkInterval = setInterval(() => {
                            if (window.MathJax && window.MathJax.startup && window.MathJax.startup.promise) {
                                clearInterval(checkInterval);
                                window.MathJax.startup.promise.then(doPrint).catch(doPrint);
                            }
                        }, 250);
                        setTimeout(() => { clearInterval(checkInterval); doPrint(); }, 6000);
                    });
                </script>
                </body></html>`);

                // 放弃被拦截的弹窗，直接下载“自动打印专用版”
                downloadBlob(printHtml, "text/html", `${data.title}_PDF打印专用.html`);

                btn.innerHTML = `<div style="font-size:20px; margin-bottom:8px;">✅</div><div style="font-size:12px;">已下载打印专用版</div>`;
                
                // 给用户最清晰的操作指引
                alert("【✅ PDF 生成完毕】\n\n受平台严格的安全拦截限制，直接弹窗会导致公式失效。\n\n因此，插件已为您下载了名为【" + data.title + "_PDF打印专用.html】的文件。\n\n👉 请直接在电脑双击打开该文件，它会自动渲染完美的公式，并自动弹出 PDF 打印窗口！");
                
                setTimeout(() => { btn.innerHTML = originalHtml; }, 4000);
            } catch(e) {
                console.error(e);
                alert("生成 PDF 失败");
                btn.innerHTML = originalHtml;
            }
        },
        
        exportHTML: async (data, btn, originalHtml) => {
            try {
                btn.innerHTML = `<div style="font-size:20px; margin-bottom:8px;">⏳</div><div style="font-size:12px;">打包图片中...</div>`;
                let rawHtml = buildHTML(data);
                
                // HTML 导出同样转换为 Base64，确保断网可看！
                rawHtml = await resolveImagesToBase64(rawHtml);
                
                downloadBlob(rawHtml, "text/html", `${data.title}.html`);
                btn.innerHTML = originalHtml;
            } catch(e) {
                console.error(e);
                alert("生成 HTML 失败");
                btn.innerHTML = originalHtml;
            }
        }
    };

    // ==========================================
    // 模块 3：批量 ZIP 导出处理器
    // ==========================================
    async function gpt_exportAllWorkspaces(format, updateBtnUI) {
        try {
            updateBtnUI("⏳ 获取鉴权...");
            await gpt_ensureAccessToken();
            if (typeof JSZip === "undefined") throw new Error("JSZip库未加载");
            const zip = new JSZip();
            
            const personalId = gpt_detectAllWorkspaceIds().find(id => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) || null;
            updateBtnUI("📦 扫描所有空间对话...");
            
            const fetchIds = async (wId) => {
                const all = new Set();
                for (const isArchived of [false, true]) {
                    let offset = 0, hasMore = true;
                    while (hasMore) {
                        const res = await fetch(`/backend-api/conversations?offset=${offset}&limit=100&order=updated${isArchived ? "&is_archived=true" : ""}`, { headers: gpt_buildHeaders(wId) });
                        const json = await res.json();
                        if (json.items?.length > 0) {
                            json.items.forEach(item => all.add(item.id));
                            hasMore = json.items.length === 100;
                            offset += json.items.length;
                        } else hasMore = false;
                        await gpt_sleep(gpt_getRandomDelay());
                    }
                }
                return Array.from(all);
            };

            const processConv = async (folder, convId, wId, index, total, prefix) => {
                updateBtnUI(`⬇️ ${prefix} (${index}/${total})`);
                const res = await fetch(`/backend-api/conversation/${convId}`, { headers: gpt_buildHeaders(wId) });
                const rawConv = await res.json();
                const shortId = rawConv.conversation_id.split("-").pop();
                const safeTitle = gpt_sanitizeFilename(rawConv.title || "Untitled");
                
                let fileContent = "";
                let ext = ".json";

                if (format === "json") {
                    fileContent = JSON.stringify(rawConv, null, 2);
                } else {
                    const parsed = parseChatGPTConversation(rawConv);
                    if (format === "md") { fileContent = Formatters.md(parsed); ext = ".md"; }
                    else if (format === "html") {
    let htmlStr = buildHTML(parsed);
    try { htmlStr = await resolveImagesToBase64(htmlStr); } catch(e) { console.error("批量HTML图片解析失败:", e); }
    fileContent = htmlStr;
    ext = ".html";
}
                    else if (format === "txt") { fileContent = Formatters.txt(parsed); ext = ".txt"; }
                }
                folder.file(`${safeTitle}_${shortId}${ext}`, fileContent);
                await gpt_sleep(gpt_getRandomDelay());
            };

            const personalIds = await fetchIds(personalId);
            if (personalIds.length > 0) {
                const folder = zip.folder("个人空间_Personal");
                for (let i = 0; i < personalIds.length; i++) {
                    await processConv(folder, personalIds[i], personalId, i + 1, personalIds.length, "抓取个人对话");
                }
            }

            const teamIds = gpt_detectAllWorkspaceIds().filter(id => id.startsWith('ws-'));
            for (let t = 0; t < teamIds.length; t++) {
                const teamId = teamIds[t];
                const folderName = teamIds.length === 1 ? "团队空间_Team" : `团队空间_Team_${t+1}`;
                const teamFolder = zip.folder(folderName);
                
                const teamConvIds = await fetchIds(teamId);
                for (let i = 0; i < teamConvIds.length; i++) {
                    await processConv(teamFolder, teamConvIds[i], teamId, i + 1, teamConvIds.length, `抓取团队[${t+1}]对话`);
                }
            }

            updateBtnUI("🗜️ 正在生成 ZIP...");
            const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `chatgpt_all_workspaces_backup_${new Date().toISOString().slice(0, 10)}.zip`;
            a.click();
            updateBtnUI("✅ 批量下载完成！");
        } catch (e) {
            alert(`全量备份失败: ${e.message}`);
            updateBtnUI("❌ 备份失败");
        }
    }


    function normalizeConvUrl(url) {
        try { const u = new URL(url, location.href); return u.origin + u.pathname; } catch (e) { return String(url || ''); }
    }

    function getConversationTitleFromLink(el) {
        const text = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim();
        return text || 'Untitled';
    }

    function getHistorySelectorsForAdapter(key) {
        return {
            gemini: ['nav a[href*="/app/"]','nav a[href*="/chat/"]','a[href*="/app/"]','conversation-item a[href]','[data-test-id*="conversation"] a[href]'],
            claude: ['a[href*="/chat/"]'],
            deepseek: ['a[href*="/a/chat/s/"]','a[href*="/chat/"]'],
            kimi: ['a[href*="/chat/"]','a[href*="/home/chat/"]'],
            qwen: ['a[href*="/chat/"]','a[href*="/c/"]'],
            grok: ['a[href*="/c/"]','a[href*="/chat/"]']
        }[key] || ['a[href*="/chat/"]'];
    }

    async function autoLoadHistoryPanels() {
        const boxes = Array.from(document.querySelectorAll('nav,aside,[role="navigation"],[class*="history"],[class*="sidebar"],[data-testid*="history"],#chat-history,.chat-history-scroll-container')).filter(el => el && el.scrollHeight > el.clientHeight + 80);
        for (const box of boxes) {
            let last = -1;
            for (let i = 0; i < 12; i++) {
                box.scrollTop = box.scrollHeight;
                await gpt_sleep(280);
                if (box.scrollHeight === last) break;
                last = box.scrollHeight;
            }
        }
    }

    function collectConversationLinksBySelectors(selectors) {
        const urls = new Map();
        selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(link => {
                const href = link.href || link.getAttribute('href');
                if (!href) return;
                try {
                    const url = new URL(href, location.href);
                    if (url.origin !== location.origin) return;
                    const key = normalizeConvUrl(url.href);
                    if (!urls.has(key)) urls.set(key, { id: key.split('/').pop(), url: url.href, title: getConversationTitleFromLink(link) });
                } catch (e) {}
            });
        });
        return Array.from(urls.values());
    }

    function collectConversationEntriesBySelectors(selectors) {
        const urls = new Map();
        selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(link => {
                const href = link.href || link.getAttribute('href');
                if (!href) return;
                try {
                    const url = new URL(href, location.href);
                    if (url.origin !== location.origin) return;
                    const key = normalizeConvUrl(url.href);
                    if (!urls.has(key)) urls.set(key, { id: key.split('/').pop(), url: url.href, title: getConversationTitleFromLink(link), element: link });
                } catch (e) {}
            });
        });
        return Array.from(urls.values());
    }

    async function waitForCondition(checkFn, timeout = 15000, interval = 250) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try { if (await checkFn()) return true; } catch (e) {}
            await gpt_sleep(interval);
        }
        return false;
    }

    async function openConversationInCurrentPage(item, platformKey) {
        const target = normalizeConvUrl(item?.url || '');
        if (!target) return false;
        const current = normalizeConvUrl(location.href);
        if (current !== target) {
            let link = null;
            if (item?.element && item.element.isConnected) link = item.element;
            if (!link) link = Array.from(document.querySelectorAll('a[href]')).find(a => normalizeConvUrl(a.href) === target) || null;
            if (link) {
                ['mousedown','mouseup','click'].forEach(type => link.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })));
            }
            await waitForCondition(() => normalizeConvUrl(location.href) === target, 16000, 250);
        }
        await gpt_sleep(platformKey === 'gemini' ? 1800 : 1200);
        return waitForCondition(() => {
            const data = extractConversationFromDocument(document, platformKey, item?.title || document.title);
            return !!(data && Array.isArray(data.messages) && data.messages.length);
        }, 12000, 400);
    }

    function cleanupNodeText(node) {
        if (!node) return '';
        const clone = node.cloneNode(true);
        clone.querySelectorAll('button,svg,path,style,script,noscript,.action-buttons,.message-actions').forEach(el => el.remove());
        clone.querySelectorAll('img').forEach((img, i) => {
            const src = img.getAttribute('src') || img.currentSrc || '';
            const alt = img.getAttribute('alt') || `image_${i + 1}`;
            img.replaceWith(clone.ownerDocument.createTextNode(`\n![${alt}](${src || 'image'})\n`));
        });
        clone.querySelectorAll('pre').forEach(pre => {
            pre.replaceWith(clone.ownerDocument.createTextNode(`\n\n\`\`\`\n${pre.textContent.trim()}\n\`\`\`\n\n`));
        });
        clone.querySelectorAll('table').forEach(table => {
            let md = '\n\n';
            const rows = table.querySelectorAll('tr');
            rows.forEach((row, rowIndex) => {
                const cells = row.querySelectorAll('th,td');
                if (!cells.length) return;
                md += '|' + Array.from(cells).map(cell => ` ${cell.textContent.replace(/\s+/g, ' ').trim()} |`).join('') + '\n';
                if (rowIndex === 0) md += '|' + Array.from(cells).map(() => ' --- |').join('') + '\n';
            });
            table.replaceWith(clone.ownerDocument.createTextNode(md + '\n'));
        });
        return clone.textContent.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
    }

    function filterTopLevelNodes(nodes) {
        return nodes.filter(node => nodes.findIndex(other => other !== node && other.contains(node)) === -1 && cleanupNodeText(node));
    }

    function pairSequentialMessages(doc, userSelector, assistantSelector, assistantName) {
        const users = filterTopLevelNodes(Array.from(doc.querySelectorAll(userSelector)));
        const assistants = filterTopLevelNodes(Array.from(doc.querySelectorAll(assistantSelector)));
        const used = new Set();
        const messages = [];
        users.forEach(userNode => {
            const text = cleanupNodeText(userNode);
            if (text) messages.push({ role: 'You', content: text });
            const assistantNode = assistants.find(node => !used.has(node) && (userNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
            if (assistantNode) {
                used.add(assistantNode);
                const aText = cleanupNodeText(assistantNode);
                if (aText) messages.push({ role: assistantName, content: aText });
            }
        });
        if (!messages.length && assistants.length) {
            assistants.forEach(node => {
                const aText = cleanupNodeText(node);
                if (aText) messages.push({ role: assistantName, content: aText });
            });
        }
        return messages;
    }

    function extractConversationFromDocument(doc, platformKey, fallbackTitle) {
        const title = (fallbackTitle || doc.title || `${platformKey}_chat`).replace(/\s+-\s+(Claude|Gemini|ChatGPT|DeepSeek|Qwen|Kimi|Grok).*$/i, '').trim() || `${platformKey}_chat`;
        let messages = [];
        if (platformKey === 'gemini') {
            const elements = Array.from(doc.querySelectorAll('user-query, model-response'));
            elements.forEach(el => {
                const isUser = el.tagName && el.tagName.toLowerCase() === 'user-query';
                const content = cleanupNodeText(el);
                if (content) messages.push({ role: isUser ? 'You' : 'Gemini', content });
            });
        } else if (platformKey === 'qwen') {
            messages = pairSequentialMessages(doc, '.qwen-chat-message-user .user-message-content, [data-role="user"], [class*="user-message"] [class*="content"]', '.qwen-chat-message-assistant .qwen-markdown, [data-role="assistant"], [class*="assistant-message"] [class*="markdown"]', 'Qwen');
        } else if (platformKey === 'kimi') {
            messages = pairSequentialMessages(doc, '[data-role="user"],[class*="message-user"],[class*="user-message"],[class*="chat-user"]', '[data-role="assistant"],[class*="assistant-message"],[class*="message-assistant"],[class*="model-answer"],[class*="markdown"]', 'Kimi');
        } else if (platformKey === 'grok') {
            messages = pairSequentialMessages(doc, '[data-role="user"],[class*="message-user"],[class*="user-message"]', '[data-role="assistant"],[class*="assistant-message"],[class*="message-assistant"],[class*="markdown"]', 'Grok');
        }
        if (!messages.length) {
            const main = doc.querySelector('main,article,[role="main"],body');
            const text = cleanupNodeText(main);
            if (text) messages = [{ role: platformKey === 'gemini' ? 'Gemini' : (platformKey.charAt(0).toUpperCase() + platformKey.slice(1)), content: text }];
        }
        return { title, messages };
    }

    async function fetchConversationDocument(url) {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`打开会话失败: ${res.status}`);
        const html = await res.text();
        return new DOMParser().parseFromString(html, 'text/html');
    }

    async function convertConversationForFormat(data, format) {
        if (format === 'json') return { content: JSON.stringify(data, null, 2), ext: '.json' };
        if (format === 'md') return { content: Formatters.md(data), ext: '.md' };
        if (format === 'txt') return { content: Formatters.txt(data), ext: '.txt' };
        let html = buildHTML(data);
        try { html = await resolveImagesToBase64(html); } catch (e) {}
        return { content: html, ext: '.html' };
    }

    async function genericBatchExport(adapter, format, updateBtnUI) {
        if (typeof JSZip === 'undefined') throw new Error('JSZip库未加载');
        updateBtnUI('📚 正在扫描历史记录...');
        await autoLoadHistoryPanels();
        const conversations = adapter.listConversations ? await adapter.listConversations() : collectConversationLinksBySelectors(getHistorySelectorsForAdapter(adapter.key));
        if (!conversations.length) throw new Error('未识别到历史对话，请先展开左侧历史列表后再试。');
        const zip = new JSZip();
        const folder = zip.folder(adapter.name);
        let savedCount = 0;
        for (let i = 0; i < conversations.length; i++) {
            const item = conversations[i];
            updateBtnUI(`⬇️ ${adapter.name} ${i + 1}/${conversations.length}`);
            let data = null;
            try {
                if (normalizeConvUrl(item.url) === normalizeConvUrl(location.href) && typeof adapter.export === 'function') data = await adapter.export();
                else if (typeof adapter.exportItem === 'function') data = await adapter.exportItem(item);
                else {
                    const doc = await fetchConversationDocument(item.url);
                    data = extractConversationFromDocument(doc, adapter.key, item.title);
                    if ((!data || !Array.isArray(data.messages) || !data.messages.length) && ['gemini','kimi','qwen','grok'].includes(adapter.key)) {
                        const opened = await openConversationInCurrentPage(item, adapter.key);
                        if (opened && typeof adapter.export === 'function') data = await adapter.export();
                    }
                }
            } catch (e) {
                console.warn('batch export skip', item.url, e);
                continue;
            }
            if (!data || !Array.isArray(data.messages) || !data.messages.length) continue;
            const formatted = await convertConversationForFormat(data, format);
            const safeTitle = gpt_sanitizeFilename((data.title || item.title || adapter.name).slice(0, 80));
            folder.file(`${safeTitle}_${String(i + 1).padStart(3, '0')}${formatted.ext}`, formatted.content);
            savedCount += 1;
            await gpt_sleep(Math.min(500, gpt_getRandomDelay()));
        }
        if (!savedCount) throw new Error('历史列表已识别，但没有成功导出的会话。请先打开任意一条历史记录后重试。');
        updateBtnUI('🗜️ 正在生成 ZIP...');
        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${adapter.key}_all_history_${new Date().toISOString().slice(0, 10)}.zip`;
        a.click();
        updateBtnUI('✅ 批量下载完成！');
    }

    function readZhLang() {
        try {
            const dataAttr = document.documentElement?.getAttribute?.('data-zhihui-lang');
            if (dataAttr === 'zh' || dataAttr === 'en') return dataAttr;
        } catch (e) {}
        try {
            const ds = document.documentElement?.dataset?.zhihuiLang;
            if (ds === 'zh' || ds === 'en') return ds;
        } catch (e) {}
        try {
            return localStorage.getItem('zhihui_lang') === 'en' ? 'en' : 'zh';
        } catch (e) {
            return 'zh';
        }
    }

    const Adapters = {
        gemini: {
            key: 'gemini',
            match: () => location.hostname.includes("gemini.google.com"),
            name: "Gemini",
            listConversations: async () => collectConversationEntriesBySelectors(getHistorySelectorsForAdapter('gemini')),
            batchExport: async function (format, updateBtnUI) { return genericBatchExport(this, format, updateBtnUI); },
            exportItem: async function (item) {
                await openConversationInCurrentPage(item, 'gemini');
                return this.export();
            },
            export: async () => {
                const data = extractConversationFromDocument(document, 'gemini', document.title.replace(" - Gemini", "").trim() || "Gemini_Chat");
                if (!data.messages.length) throw new Error("未能读取到对话，请确保您已进入具体的历史对话页面，而不是在首页。");
                return data;
            }
        },
        deepseek: {
            key: 'deepseek',
            match: () => location.hostname.includes("chat.deepseek.com"),
            name: "DeepSeek",
            listConversations: async () => collectConversationLinksBySelectors(getHistorySelectorsForAdapter('deepseek')),
            batchExport: async function (format, updateBtnUI) { return genericBatchExport(this, format, updateBtnUI); },
            exportItem: async (item) => {
                const match = String(item.url || '').match(/\/a\/chat\/s\/([a-f0-9-]+)/);
                if (!match) throw new Error("请先点击进入具体的 DeepSeek 历史对话页面");
                const token = JSON.parse(localStorage.getItem("userToken"))?.value;
                if (!token) throw new Error("未找到鉴权 Token");
                const res = await fetch(`https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${match[1]}&cache_version=0`, { headers: { 'Authorization': `Bearer ${token}` } });
                const data = await res.json();
                return {
                    title: data?.data?.biz_data?.chat_session?.title || item.title || "DeepSeek_Chat",
                    messages: (data?.data?.biz_data?.chat_messages || []).filter(m => m.status === "FINISHED").map(m => ({
                        role: m.role === "USER" ? "You" : "DeepSeek",
                        content: (m.thinking_content ? `> **🤔 思考过程:**
${m.thinking_content}

---

` : "") + (m.content || "")
                    }))
                };
            },
            export: async function () { return this.exportItem({ url: location.href, title: document.title }); }
        },
        claude: {
            key: 'claude',
            match: () => location.hostname.includes("claude.ai"),
            name: "Claude",
            listConversations: async () => collectConversationLinksBySelectors(getHistorySelectorsForAdapter('claude')),
            batchExport: async function (format, updateBtnUI) { return genericBatchExport(this, format, updateBtnUI); },
            exportItem: async (item) => {
                const match = String(item.url || '').match(/\/chat\/([a-f0-9-]+)/);
                if (!match) throw new Error("请先点击进入具体的 Claude 历史对话页面");
                const orgIdMatch = document.cookie.match(/lastActiveOrg=([^;]+)/);
                if (!orgIdMatch) throw new Error('未找到 Claude 组织信息');
                const res = await fetch(`https://claude.ai/api/organizations/${orgIdMatch[1]}/chat_conversations/${match[1]}`);
                const data = await res.json();
                const messages = (data.chat_messages || []).map(m => ({ role: m.sender === "human" ? "You" : "Claude", content: m.text || "" }));
                return { title: data.name || item.title || "Claude_Chat", messages };
            },
            export: async function () { return this.exportItem({ url: location.href, title: document.title }); }
        },
        kimi: {
            key: 'kimi',
            match: () => location.hostname.includes("kimi.com"),
            name: "Kimi",
            listConversations: async () => collectConversationLinksBySelectors(getHistorySelectorsForAdapter('kimi')),
            batchExport: async function (format, updateBtnUI) { return genericBatchExport(this, format, updateBtnUI); },
            exportItem: async function (item) {
                await openConversationInCurrentPage(item, 'kimi');
                return this.export();
            },
            export: async () => {
                const data = extractConversationFromDocument(document, 'kimi', document.title || 'Kimi_Chat');
                if (!data.messages.length) throw new Error('未识别到当前 Kimi 对话，请先进入具体历史对话。');
                return data;
            }
        },
        qwen: {
            key: 'qwen',
            match: () => /(?:^|\.)qwen\.ai$/.test(location.hostname) || location.hostname.includes('chat.qwen.ai'),
            name: "Qwen",
            listConversations: async () => collectConversationLinksBySelectors(getHistorySelectorsForAdapter('qwen')),
            batchExport: async function (format, updateBtnUI) { return genericBatchExport(this, format, updateBtnUI); },
            export: async () => {
                const data = extractConversationFromDocument(document, 'qwen', document.title || 'Qwen_Chat');
                if (!data.messages.length) throw new Error('未识别到当前 Qwen 对话，请先进入具体历史对话。');
                return data;
            }
        },
        grok: {
            key: 'grok',
            match: () => location.hostname.includes("grok.com"),
            name: "Grok",
            listConversations: async () => collectConversationLinksBySelectors(getHistorySelectorsForAdapter('grok')),
            batchExport: async function (format, updateBtnUI) { return genericBatchExport(this, format, updateBtnUI); },
            exportItem: async (item) => {
                const match = String(item.url || '').match(/\/c\/([a-f0-9-]+)/);
                if (!match) throw new Error("请先点击进入具体的 Grok 历史对话页面");
                const id = match[1];
                const nodeRes = await fetch(`https://grok.com/rest/app-chat/conversations/${id}/response-node?includeThreads=true`);
                const nodeData = await nodeRes.json();
                const res = await fetch(`https://grok.com/rest/app-chat/conversations/${id}/load-responses`, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ responseIds: (nodeData.responseNodes || []).map(n => n.responseId) })
                });
                const data = await res.json();
                return {
                    title: item.title || `Grok_Chat_${id.substring(0,6)}`,
                    messages: (data.responses || []).sort((a,b) => new Date(a.createTime) - new Date(b.createTime)).filter(r => !r.partial).map(r => ({
                        role: r.sender === "human" ? "You" : "Grok", content: r.message || ""
                    }))
                };
            },
            export: async function () { return this.exportItem({ url: location.href, title: document.title }); }
        },
        chatgpt: {
            key: 'chatgpt',
            match: () => isChatGPT,
            name: "ChatGPT",
            batchExport: async (format, updateBtnUI) => gpt_exportAllWorkspaces(format, updateBtnUI),
            export: async () => {
                const match = location.href.match(/\/c\/([a-f0-9-]+)/);
                if (!match) throw new Error("请先在网页左侧点击进入一个具体的历史对话后使用！");
                const token = await gpt_ensureAccessToken();
                const res = await fetch(`/backend-api/conversation/${match[1]}`, { headers: { 'Authorization': `Bearer ${token}` } });
                const data = await res.json();
                return parseChatGPTConversation(data);
            }
        }
    };

    function createUnifiedModal() {
        const currentAdapter = Object.values(Adapters).find(a => a.match());
        if (!currentAdapter) return null;

        const exportLang = readZhLang();
        const isEn = exportLang === 'en';
        const L = {
            batchFormats: isEn ? [
                { id: "md", icon: "📝", label: "ZIP as MD", color: "#0f172a", border: "#94a3b8" },
                { id: "html", icon: "🌐", label: "ZIP as HTML", color: "#ea580c", border: "#fdba74" },
                { id: "txt", icon: "📃", label: "ZIP as TXT", color: "#475569", border: "#94a3b8" },
                { id: "json", icon: "🛠️", label: "ZIP as JSON", color: "#16a34a", border: "#86efac" }
            ] : [
                { id: "md", icon: "📝", label: "打包为 MD", color: "#0f172a", border: "#94a3b8" },
                { id: "html", icon: "🌐", label: "打包为 HTML", color: "#ea580c", border: "#fdba74" },
                { id: "txt", icon: "📃", label: "打包为 TXT", color: "#475569", border: "#94a3b8" },
                { id: "json", icon: "🛠️", label: "打包为 JSON", color: "#16a34a", border: "#86efac" }
            ],
            batchTitle: isEn ? "Export all records" : "一键导出全部记录",
            batchDesc: isEn
                ? (currentAdapter && currentAdapter.key === "chatgpt"
                    ? "Silently fetch <b>all history from your personal workspace + all team workspaces</b> in the background, then download it as a single ZIP file."
                    : "First fetch <b>all currently loaded conversations</b> from the history list in the left sidebar, then bundle them into one ZIP file for download.")
                : (currentAdapter && currentAdapter.key === "chatgpt"
                    ? "将后台静默抓取当前账号下 <b>个人空间 + 所有团队空间</b> 的全部历史记录，并打包为单个 ZIP 文件下载。"
                    : "将优先抓取当前账号左侧历史列表中的 <b>全部已加载对话</b>，自动打包为 ZIP 文件下载。"),
            batchNote: isEn
                ? "(Batch ZIP export does not support PDF. The history list will auto-scroll first to load more records.)"
                : "(注：批量打包不支持 PDF，会先自动滚动历史列表加载更多记录)",
            singleFormats: isEn ? [
                { id: "pdf", icon: "📄", label: "Export PDF", color: "#e11d48", bg: "#ffe4e6" },
                { id: "md", icon: "📝", label: "Export MD", color: "#0f172a", bg: "#f1f5f9" },
                { id: "html", icon: "🌐", label: "Export HTML", color: "#ea580c", bg: "#ffedd5" },
                { id: "txt", icon: "📃", label: "Export TXT", color: "#475569", bg: "#f1f5f9" },
                { id: "json", icon: "🛠️", label: "Export JSON", color: "#16a34a", bg: "#dcfce7" }
            ] : [
                { id: "pdf", icon: "📄", label: "导出 PDF", color: "#e11d48", bg: "#ffe4e6" },
                { id: "md", icon: "📝", label: "导出 MD", color: "#0f172a", bg: "#f1f5f9" },
                { id: "html", icon: "🌐", label: "导出 HTML", color: "#ea580c", bg: "#ffedd5" },
                { id: "txt", icon: "📃", label: "导出 TXT", color: "#475569", bg: "#f1f5f9" },
                { id: "json", icon: "🛠️", label: "导出 JSON", color: "#16a34a", bg: "#dcfce7" }
            ],
            modalTitle: isEn ? "Export records" : "导出记录",
            singleTitle: isEn ? "Export current conversation" : "导出当前单条对话",
            singleDesc: isEn ? "Open a specific conversation from the left history list before using this." : "请先在网页左侧进入具体的历史对话后使用。",
            currentPlatform: isEn ? "Detected platform" : "当前识别平台",
            batchStarting: isEn ? "🚀 Preparing batch export..." : "🚀 准备开始批量抓取...",
            batchFailed: isEn ? "Batch export failed" : "批量导出失败",
            fetching: isEn ? "Fetching" : "获取中"
        };

        const oldOverlay = document.getElementById("ai-export-overlay");
        if (oldOverlay) oldOverlay.remove();
        const overlay = document.createElement("div");
        overlay.id = "ai-export-overlay";
        Object.assign(overlay.style, {
            position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
            backgroundColor: "rgba(0, 0, 0, 0.5)", backdropFilter: "blur(4px)",
            zIndex: "999999", display: "none", alignItems: "center", justifyContent: "center",
            opacity: "0", transition: "opacity 0.25s ease"
        });

        const modal = document.createElement("div");
        Object.assign(modal.style, {
            backgroundColor: "#ffffff", borderRadius: "20px", padding: "30px",
            width: "560px", maxWidth: "90%", boxShadow: "0 24px 48px rgba(0,0,0,0.2)",
            transform: "scale(0.95)", transition: "transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
            fontFamily: '"Times New Roman", Times, "Microsoft YaHei", "微软雅黑", sans-serif', boxSizing: "border-box",
            maxHeight: "90vh", overflowY: "auto"
        });

        let zipCard = "";
        if (currentAdapter && currentAdapter.batchExport) {
            const batchFormats = L.batchFormats;

            const batchBtnsHtml = batchFormats.map(conf => `
                <button class="batch-export-btn" data-format="${conf.id}" style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:12px 6px; border-radius:12px; border:1px solid ${conf.border}; background:#fff; color:${conf.color}; cursor:pointer; font-size:12px; font-weight:600; transition:all 0.2s ease;">
                    <div style="font-size:20px; margin-bottom:6px;">${conf.icon}</div>
                    <div>${conf.label}</div>
                </button>
            `).join("");

            zipCard = `
                <div style="background: linear-gradient(145deg, #f0fdf4, #ecfdf5); border: 1px solid #10a37f; border-radius: 16px; padding: 20px; margin-bottom: 24px; box-shadow: 0 4px 12px rgba(16,163,127,0.05);">
                    <h3 style="margin: 0 0 10px 0; color: #065f46; font-size: 18px; display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 24px;">📦</span> ${L.batchTitle}
                    </h3>
                    <p style="margin: 0 0 16px 0; color: #047857; font-size: 13px; line-height: 1.5;">
${L.batchDesc}
                        <span style="display:block; margin-top:4px; font-size:11px; opacity:0.8;">${L.batchNote}</span>
                    </p>
                    <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:12px;" id="batch-grid">
                        ${batchBtnsHtml}
                    </div>
                    <div id="batch-status" style="margin-top:14px; font-size:14px; color:#10a37f; font-weight:700; text-align:center; display:none;"></div>
                </div>
            `;
        }

        const singleButtonsConfig = L.singleFormats;

        modal.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:24px;">
                <h2 style="margin:0; font-size:24px; color:#0f172a; font-weight: 800;">${L.modalTitle}</h2>
                <button id="ai-export-close" style="background:none; border:none; font-size:28px; cursor:pointer; color:#94a3b8; line-height:1; padding:0;">&times;</button>
            </div>
            
            ${zipCard}

            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 16px; padding: 20px;">
                <h3 style="margin: 0 0 8px 0; color: #0f172a; font-size: 16px; display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 20px;">🎯</span> ${L.singleTitle}
                </h3>
                <p style="margin: 0 0 16px 0; color: #64748b; font-size: 13px; line-height: 1.5;">
                    ${L.singleDesc}<br/>
                    ${L.currentPlatform}：<strong style="color:#3b82f6;">${currentAdapter.name}</strong>
                </p>
                <div id="single-grid-container" style="display:grid; grid-template-columns:repeat(5, 1fr); gap:12px;"></div>
            </div>
        `;

        if (currentAdapter && currentAdapter.batchExport) {
            const batchBtns = modal.querySelectorAll(".batch-export-btn");
            const statusDiv = modal.querySelector("#batch-status");
            batchBtns.forEach(btn => {
                btn.onmouseenter = () => { btn.style.transform = "translateY(-2px)"; btn.style.boxShadow = "0 6px 12px rgba(16,163,127,0.15)"; btn.style.background = "#f0fdf4"; };
                btn.onmouseleave = () => { btn.style.transform = "none"; btn.style.boxShadow = "none"; btn.style.background = "#fff"; };
                btn.onclick = async () => {
                    const format = btn.getAttribute("data-format");
                    batchBtns.forEach(b => { b.style.pointerEvents = "none"; b.style.opacity = "0.5"; });
                    statusDiv.style.display = "block";
                    statusDiv.innerText = L.batchStarting;
                    try {
                        await currentAdapter.batchExport(format, (text) => {
                            statusDiv.innerText = text;
                        });
                    } catch (e) {
                        statusDiv.innerText = `❌ ${e.message || L.batchFailed}`;
                    } finally {
                        batchBtns.forEach(b => { b.style.pointerEvents = "auto"; b.style.opacity = "1"; });
                        setTimeout(() => { statusDiv.style.display = "none"; }, 4000);
                    }
                };
            });
        }

        const singleGrid = modal.querySelector("#single-grid-container");
        singleButtonsConfig.forEach(conf => {
            const btn = document.createElement("button");
            btn.innerHTML = `<div style="font-size:24px; margin-bottom:6px;">${conf.icon}</div><div style="font-weight:600;">${conf.label}</div>`;
            Object.assign(btn.style, {
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                padding: "14px 8px", borderRadius: "12px", border: "none", backgroundColor: conf.bg, color: conf.color, 
                cursor: "pointer", fontSize: "12px", transition: "all 0.2s ease"
            });
            btn.onmouseenter = () => { btn.style.transform = "translateY(-3px)"; btn.style.boxShadow = `0 6px 12px ${conf.bg}`; };
            btn.onmouseleave = () => { btn.style.transform = "none"; btn.style.boxShadow = "none"; };
            
            btn.onclick = async () => {
                const originalHtml = btn.innerHTML;
                btn.innerHTML = `<div style="font-size:18px; margin-bottom:6px;">⏳</div><div>${L.fetching}</div>`;
                try {
                    const data = await currentAdapter.export();
                    if (conf.id === "pdf") await Formatters.exportPDF(data, btn, originalHtml);
                    else if (conf.id === "md") { downloadBlob(Formatters.md(data), "text/markdown", `${data.title}.md`); btn.innerHTML = originalHtml; }
                    else if (conf.id === "html") await Formatters.exportHTML(data, btn, originalHtml); // 这一行是关键改动
                    else if (conf.id === "txt") { downloadBlob(Formatters.txt(data), "text/plain", `${data.title}.txt`); btn.innerHTML = originalHtml; }
                    else if (conf.id === "json") { downloadBlob(JSON.stringify(data, null, 2), "application/json", `${data.title}.json`); btn.innerHTML = originalHtml; }
                } catch (e) {
                    alert(e.message);
                    btn.innerHTML = originalHtml;
                }
            };
            singleGrid.appendChild(btn);
        });

        overlay.appendChild(modal);
        overlay.classList.add("zh-floating-ui");
        document.body.appendChild(overlay);

        const closeModal = () => {
            overlay.style.opacity = "0"; modal.style.transform = "scale(0.95)";
            setTimeout(() => overlay.style.display = "none", 250);
        };
        modal.querySelector("#ai-export-close").onclick = closeModal;
        overlay.onclick = (e) => { if(e.target === overlay) closeModal(); };

        return () => {
            overlay.style.display = "flex";
            setTimeout(() => { overlay.style.opacity = "1"; modal.style.transform = "scale(1)"; }, 10);
        };
    }

    function init() {
        window.gpt_exportChat = function () {
            const showModal = createUnifiedModal();
            if (!showModal) return;
            showModal();
        };
        window.addEventListener('message', function (event) {
            const data = event && event.data;
            if (!data || data.source !== 'zh-ai-chat-archiver' || data.type !== 'zh_lang_change') return;
            const oldOverlay = document.getElementById('ai-export-overlay');
            if (oldOverlay) oldOverlay.remove();
        });
        console.log("GPT Universal Exporter: Bound to Side Panel globally.");
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();