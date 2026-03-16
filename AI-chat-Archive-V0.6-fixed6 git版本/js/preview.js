// js/preview.js
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['gptPreviewHtml'], (result) => {
        if (result.gptPreviewHtml) {
            let html = result.gptPreviewHtml;

            // 【核心修复】：在 HTML 结尾动态注入一段“智能等待”脚本
            // 它的作用是：死死盯住 MathJax，必须等所有公式渲染成漂亮排版后，再拉起 PDF 打印窗口！
            const printWaitScript = `
            <script>
                window.addEventListener('load', () => {
                    let printed = false;
                    const doPrint = () => {
                        if (!printed) {
                            printed = true;
                            // 渲染完成后，预留 800 毫秒给浏览器完成最后的画面重绘
                            setTimeout(() => window.print(), 800); 
                        }
                    };

                    const checkInterval = setInterval(() => {
                        // 探测 MathJax 3.x 官方的渲染状态 Promise
                        if (window.MathJax && window.MathJax.startup && window.MathJax.startup.promise) {
                            clearInterval(checkInterval);
                            window.MathJax.startup.promise.then(doPrint).catch(doPrint);
                        }
                    }, 250);

                    // 终极兜底机制：如果网络卡顿导致公式引擎 6 秒都没加载出来，为了防止页面卡死，强制执行打印
                    setTimeout(() => {
                        clearInterval(checkInterval);
                        doPrint();
                    }, 6000);
                });
            </script>
            </body></html>`;

            // 将这段探测脚本悄悄塞进生成的 HTML 底部
            html = html.replace('</body></html>', printWaitScript);

            document.open();
            document.write(html);
            document.close();
        } else {
            document.body.innerHTML = "<h2 style='text-align:center;margin-top:50px;color:red;'>读取数据失败，请返回聊天页重新点击导出。</h2>";
        }
    });
});