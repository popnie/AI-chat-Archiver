// markmap‑bridge.js  (runs in the PAGE context)
(() => {
  if (window.__markmapBridgeLoaded) return;     // idempotent
  window.__markmapBridgeLoaded = true;

  window.mmPool = window.mmPool || {};
  window.__acnMarkmapCompat = window.__acnMarkmapCompat || {};

  function stripHtmlToText(input) {
    const text = String(input ?? '');
    return text
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function installTrustedHtmlCompatForD3() {
    if (window.__acnMarkmapCompat.d3HtmlPatched) return;

    const d3 = window.d3;
    const proto = d3?.selection?.prototype;
    if (!proto || typeof proto.html !== 'function') return;

    let policy = null;
    if (window.trustedTypes?.createPolicy) {
      const policyNames = ['acn-markmap', 'default'];
      for (const name of policyNames) {
        try {
          policy = window.trustedTypes.createPolicy(name, {
            createHTML: (html) => String(html ?? '')
          });
          break;
        } catch (_) {
          // Try next policy name.
        }
      }
    }

    const originalHtml = proto.html;
    const assignTextFallback = function (selection, value) {
      if (typeof value === 'function') {
        return selection.each(function assignText(...args) {
          const next = value.apply(this, args);
          this.textContent = stripHtmlToText(next);
        });
      }
      return selection.each(function assignStaticText() {
        this.textContent = stripHtmlToText(value);
      });
    };

    const isTrustedHtmlError = (err) =>
      /TrustedHTML|requires 'TrustedHTML' assignment/i.test(String(err?.message || err));

    proto.html = function patchedHtml(value) {
      // getter path
      if (!arguments.length) {
        return originalHtml.call(this);
      }

      // Preferred path: convert to TrustedHTML if a policy can be created.
      if (policy) {
        try {
          if (typeof value === 'function') {
            return originalHtml.call(this, function wrappedHtml(...args) {
              const next = value.apply(this, args);
              if (next == null) return null;
              return policy.createHTML(next);
            });
          }
          if (value == null) return originalHtml.call(this, null);
          return originalHtml.call(this, policy.createHTML(value));
        } catch (err) {
          if (isTrustedHtmlError(err)) {
            return assignTextFallback(this, value);
          }
          throw err;
        }
      }

      // No policy available: try native html() first. If TT blocks it,
      // degrade to text content to keep rendering functional.
      try {
        return originalHtml.call(this, value);
      } catch (err) {
        if (isTrustedHtmlError(err)) {
          return assignTextFallback(this, value);
        }
        throw err;
      }
    };

    window.__acnMarkmapCompat.d3HtmlPatched = true;
    console.log('[MarkmapBridge] TrustedHTML compat patch enabled');
  }

  function isFinitePositive(value) {
    return Number.isFinite(value) && value > 0;
  }

  function clamp(value, min, max) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return Math.min(Math.max(value, lo), hi);
  }

  function getNaturalMindmapBounds(mm) {
    const rect = mm?.state?.rect || {};
    const naturalWidth = rect.x2 - rect.x1;
    const naturalHeight = rect.y2 - rect.y1;
    if (!isFinitePositive(naturalWidth) || !isFinitePositive(naturalHeight)) return null;
    return { rect, naturalWidth, naturalHeight };
  }

  function autoSizePopupToMindmap(svg, bounds) {
    if (!bounds) return null;
    const popup = svg.closest('.mindmap-popup');
    if (!popup) return null;

    // Keep maximized window untouched.
    if (popup.style.width === '100vw' || popup.style.height === '100vh') return null;
    if (popup.dataset.mmAutoSized === 'true') return null;

    const { naturalWidth, naturalHeight } = bounds;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const widthMin = 720;
    const widthMax = Math.min(1200, Math.floor(viewportWidth * 0.9));
    const heightMin = 460;
    const heightMax = Math.floor(viewportHeight * 0.85);

    const targetWidth = clamp(naturalWidth + 180, widthMin, widthMax);
    const targetHeight = clamp(naturalHeight + 180, heightMin, heightMax);
    const targetTop = Math.max(12, Math.round((viewportHeight - targetHeight) / 2));

    popup.style.width = `${Math.round(targetWidth)}px`;
    popup.style.height = `${Math.round(targetHeight)}px`;
    popup.style.left = '50%';
    popup.style.transform = 'translateX(-50%)';
    popup.style.top = `${targetTop}px`;
    popup.dataset.mmAutoSized = 'true';

    return {
      targetWidth: Math.round(targetWidth),
      targetHeight: Math.round(targetHeight),
      naturalWidth: Math.round(naturalWidth),
      naturalHeight: Math.round(naturalHeight)
    };
  }

  function getResponsiveNodeMaxWidth(svg) {
    const popup = svg.closest('.mindmap-popup');
    const content = popup?.querySelector('.mindmap-content');
    const svgWidth = svg.getBoundingClientRect().width;
    const baseWidth =
      content?.clientWidth ||
      popup?.clientWidth ||
      svgWidth ||
      Math.floor(window.innerWidth * 0.7);

    // Keep node text width close to the visible panel width while avoiding extremes.
    const usableWidth = Math.max(0, baseWidth - 72);
    const targetWidth = Math.round(usableWidth * 0.72);
    return clamp(targetWidth, 420, 860);
  }

  function estimateFitScale(width, height, naturalWidth, naturalHeight) {
    if (
      !isFinitePositive(width) ||
      !isFinitePositive(height) ||
      !isFinitePositive(naturalWidth) ||
      !isFinitePositive(naturalHeight)
    ) {
      return null;
    }
    return Math.min(width / naturalWidth, height / naturalHeight);
  }

  function parseScaleFromTransform(transformValue) {
    if (!transformValue || typeof transformValue !== 'string') return null;
    const match = transformValue.match(/scale\(([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\)/);
    if (!match) return null;
    const scale = Number(match[1]);
    return Number.isFinite(scale) ? scale : null;
  }

  function anchorMapAtScaleOne(mm, width, height, rect) {
    if (!mm?.svg || !mm?.zoom || !window.d3 || !rect) return false;

    const naturalWidth = rect.x2 - rect.x1;
    const naturalHeight = rect.y2 - rect.y1;
    if (!isFinitePositive(naturalWidth) || !isFinitePositive(naturalHeight)) return false;

    const paddingX = 24;
    const paddingY = 16;
    const targetX = paddingX;
    const targetY =
      naturalHeight <= (height - paddingY * 2)
        ? paddingY + (height - paddingY * 2 - naturalHeight) / 2
        : paddingY;

    const tx = targetX - rect.x1;
    const ty = targetY - rect.y1;

    try {
      mm.svg.call(mm.zoom.transform, window.d3.zoomIdentity.translate(tx, ty).scale(1));
      return true;
    } catch (_) {
      return false;
    }
  }

  async function safeFitMarkmap(mm, svg, options = {}) {
    const { maxFrames = 6, preventDownscale = false, minScale = 1 } = options;
    for (let i = 0; i < maxFrames; i++) {
      const { width, height } = svg.getBoundingClientRect();
      const bounds = getNaturalMindmapBounds(mm);
      const rect = bounds?.rect;
      const naturalWidth = bounds?.naturalWidth;
      const naturalHeight = bounds?.naturalHeight;

      const canFit =
        isFinitePositive(width) &&
        isFinitePositive(height) &&
        isFinitePositive(naturalWidth) &&
        isFinitePositive(naturalHeight);

      if (canFit) {
        const fitScale = estimateFitScale(width, height, naturalWidth, naturalHeight);
        const shouldPreventDownscale =
          preventDownscale && Number.isFinite(fitScale) && fitScale < minScale;

        if (shouldPreventDownscale) {
          const anchoredAtScaleOne = anchorMapAtScaleOne(mm, width, height, rect);
          return {
            fitApplied: false,
            preventedDownscale: true,
            fitScaleEstimate: fitScale,
            appliedScale: 1,
            anchoredAtScaleOne
          };
        }

        try {
          await mm.fit();
        } catch (_) {
          // Keep map rendered even if fit animation is interrupted.
        }

        const appliedScale = parseScaleFromTransform(mm?.g?.attr?.('transform'));
        if (preventDownscale && Number.isFinite(appliedScale) && appliedScale < minScale) {
          const anchoredAtScaleOne = anchorMapAtScaleOne(mm, width, height, rect);
          return {
            fitApplied: false,
            preventedDownscale: true,
            fitScaleEstimate: fitScale,
            appliedScale,
            anchoredAtScaleOne
          };
        }

        return {
          fitApplied: true,
          preventedDownscale: false,
          fitScaleEstimate: fitScale,
          appliedScale: appliedScale ?? fitScale
        };
      }

      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return {
      fitApplied: false,
      preventedDownscale: false,
      fitScaleEstimate: null,
      appliedScale: null
    };
  }

  function installSafeZoomHandler(mm) {
    if (!mm?.zoom || !mm?.g) return;

    mm.zoom.on('zoom', (event) => {
      const transform = event?.transform;
      if (!transform) return;
      if (!Number.isFinite(transform.x)) return;
      if (!Number.isFinite(transform.y)) return;
      if (!isFinitePositive(transform.k)) return;
      mm.g.attr('transform', transform);
    });
  }

  window.addEventListener('message', async ev => {
    // if (ev.data?.type !== 'RENDER_MM') return;

    // const { svgId, markdown } = ev.data;
    const { type, svgId, markdown, mmId } = ev.data || {};
    /* ─── 1. destroy request ─── */
    if (type === 'DESTROY_MM') {
      const mm = window.mmPool?.[mmId];
      if (mm) {
        mm.svg?.interrupt();
        mm.g?.interrupt();

        /* 2 ▸ detach zoom & resize listeners so no NEW tweens can start  */
        if (mm.zoom) mm.zoom.on('zoom', null);         // disable wheel / drag zoom
        if (mm.observer) mm.observer.disconnect();     // stop auto-fit on resize

        console.log('[MarkmapBridge] destroying', mmId);
        mm.destroy();               // <‑‑ Markmap ≥ 0.16 has this
        delete window.mmPool[mmId];
      }
      window.postMessage({ type: 'DESTROY_MM_DONE', mmId }, '*');
      return;                       // nothing else to do
    }
    /* ─── 2. render request ─── */
    if (type !== 'RENDER_MM') return;

    try {
      installTrustedHtmlCompatForD3();

      const { Markmap, Transformer } = window.markmap;
      if (!Markmap) throw new Error('Markmap not ready');

      const toolbarFn =
        window.markmap.toolbar            // UMD export
        || window.markmapToolbar             // global set by the file
        || null;

      const svg = document.getElementById(svgId);
      const root = new Transformer().transform(markdown).root;
      const nodeMaxWidth = getResponsiveNodeMaxWidth(svg);
      const mm = Markmap.create(svg, {
        autoLoad: false,
        autoFit: false,
        duration: 0,
        maxWidth: nodeMaxWidth
      });

      installSafeZoomHandler(mm);
      await mm.setData(root);
      const naturalBounds = getNaturalMindmapBounds(mm);
      const autoSize = autoSizePopupToMindmap(svg, naturalBounds);
      const fit = await safeFitMarkmap(mm, svg, { preventDownscale: true, minScale: 1 });

      /* save a handle so the content script can destroy it later */
      const id = Date.now().toString(36);   // quick unique key
      svg.dataset.mmId = id;
      window.mmPool[id] = mm;

      // Create a single tooltip for all toolbar buttons
      // const toolbarTooltip = document.createElement('div');
      // toolbarTooltip.className = 'custom-toolbar-tooltip';
      // toolbarTooltip.style.position = 'absolute';
      // toolbarTooltip.style.padding = '2px 8px';
      // toolbarTooltip.style.background = '#222';
      // toolbarTooltip.style.color = '#fff';
      // toolbarTooltip.style.borderRadius = '4px';
      // toolbarTooltip.style.fontSize = '12px';
      // toolbarTooltip.style.pointerEvents = 'none';
      // toolbarTooltip.style.whiteSpace = 'nowrap';
      // toolbarTooltip.style.zIndex = '99999';
      // toolbarTooltip.style.display = 'none';
      // document.body.appendChild(toolbarTooltip);

      // Create and attach toolbar
      if (window.markmap && window.markmap.Toolbar) {
        const toolbar = window.markmap.Toolbar.create(mm);

        // Add a custom button to the toolbar
        // Create the SVG icon as a DOM element
        const svgIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svgIcon.setAttribute("width", "10");
        svgIcon.setAttribute("height", "10");
        svgIcon.setAttribute("viewBox", "0 0 24 24");
        svgIcon.setAttribute("fill", "none");
        svgIcon.setAttribute("stroke", "currentColor");
        svgIcon.setAttribute("stroke-width", "3");
        svgIcon.setAttribute("stroke-linecap", "round");
        svgIcon.setAttribute("stroke-linejoin", "round");

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4");
        svgIcon.appendChild(path);

        const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        polyline.setAttribute("points", "7 10 12 15 17 10");
        svgIcon.appendChild(polyline);

        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", "12");
        line.setAttribute("y1", "15");
        line.setAttribute("x2", "12");
        line.setAttribute("y2", "3");
        svgIcon.appendChild(line);
        svgIcon.classList.add('mm-toolbar-download-icon');

        // Register the toolbar button
        toolbar.register({
          id: "export",
          title: "Download SVG",
          content: svgIcon, // Pass the DOM element, not a string!
          onClick: () => {
            const serializer = new XMLSerializer();
            const svgString = serializer.serializeToString(svg);
            const blob = new Blob([svgString], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'mindmap.svg';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }
        });

        // toolbar.register({
        //   id: "export",
        //   title: "Export",
        //   content: "Export",
        //   onClick: (e) => {
        //       // Create a simple context menu
        //       const menu = document.createElement('div');
        //       menu.style.cssText = `
        //           position: absolute;
        //           background: #2a2a2e;
        //           border: 1px solid #555;
        //           border-radius: 4px;
        //           padding: 4px 0;
        //           z-index: 2147483648;
        //           box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        //       `;
        //       // SVG
        //       const svgOption = document.createElement('div');
        //       svgOption.textContent = 'Export as SVG';
        //       svgOption.style.cssText = 'padding: 8px 16px; cursor: pointer; color: white;';
        //       svgOption.onmouseover = () => svgOption.style.background = '#404040';
        //       svgOption.onmouseout = () => svgOption.style.background = 'transparent';
        //       svgOption.onclick = () => {
        //           const serializer = new XMLSerializer();
        //           const svgString = serializer.serializeToString(svg);
        //           const blob = new Blob([svgString], {type: 'image/svg+xml'});
        //           const url = URL.createObjectURL(blob);
        //           const a = document.createElement('a');
        //           a.href = url;
        //           a.download = 'mindmap.svg';
        //           document.body.appendChild(a);
        //           a.click();
        //           document.body.removeChild(a);
        //           URL.revokeObjectURL(url);
        //       };

        //       // PNG
        //       // const pngOption = document.createElement('div');
        //       // pngOption.textContent = 'Export as PNG';
        //       // pngOption.style.cssText = 'padding: 8px 16px; cursor: pointer; color: white;';
        //       // pngOption.onmouseover = () => pngOption.style.background = '#404040';
        //       // pngOption.onmouseout = () => pngOption.style.background = 'transparent';
        //       // pngOption.onclick = () => exportAsImage('png');

        //       // JPG
        //       // const jpgOption = document.createElement('div');
        //       // jpgOption.textContent = 'Export as JPG';
        //       // jpgOption.style.cssText = 'padding: 8px 16px; cursor: pointer; color: white;';
        //       // jpgOption.onmouseover = () => jpgOption.style.background = '#404040';
        //       // jpgOption.onmouseout = () => jpgOption.style.background = 'transparent';
        //       // jpgOption.onclick = () => exportAsImage('jpeg');


        //       // HTML
        //       // const htmlOption = document.createElement('div');
        //       // htmlOption.textContent = 'Export as HTML';
        //       // htmlOption.style.cssText = 'padding: 8px 16px; cursor: pointer; color: white;';
        //       // htmlOption.onmouseover = () => htmlOption.style.background = '#404040';
        //       // htmlOption.onmouseout = () => htmlOption.style.background = 'transparent';
        //       // htmlOption.onclick = () => exportAsHTML();

        //       // menu.appendChild(pngOption);
        //       // menu.appendChild(jpgOption);
        //       menu.appendChild(svgOption);
        //       // menu.appendChild(htmlOption);
        //       // Position near the button

        //       const rect = e.target.getBoundingClientRect();
        //       menu.style.left = rect.left + 'px';
        //       menu.style.top = (rect.top - 80) + 'px';

        //       document.body.appendChild(menu);

        //       // Remove menu when clicking elsewhere
        //       setTimeout(() => {
        //           document.addEventListener('click', function removeMenu() {
        //               menu.remove();
        //               document.removeEventListener('click', removeMenu);
        //           });
        //       }, 100);
        //   }
        // });

        // Helper function for both PNG and JPG
        //   function exportAsImage(format) {
        //     // Get the SVG element
        //     const svgElement = svg;
        //     const serializer = new XMLSerializer();
        //     const svgString = serializer.serializeToString(svgElement);

        //     // Create a canvas
        //     const canvas = document.createElement('canvas');
        //     canvas.width = svgElement.width.baseVal.value || 800;
        //     canvas.height = svgElement.height.baseVal.value || 600;
        //     const ctx = canvas.getContext('2d');

        //     // Create an image from SVG
        //     const img = new window.Image();
        //     const svgBlob = new Blob([svgString], {type: 'image/svg+xml;charset=utf-8'});
        //     const url = URL.createObjectURL(svgBlob);

        //     img.onload = function() {
        //         ctx.drawImage(img, 0, 0);
        //         URL.revokeObjectURL(url);

        //         canvas.toBlob(function(blob) {
        //             const a = document.createElement('a');
        //             a.href = URL.createObjectURL(blob);
        //             a.download = `mindmap.${format === 'jpeg' ? 'jpg' : format}`;
        //             document.body.appendChild(a);
        //             a.click();
        //             document.body.removeChild(a);
        //         }, `image/${format}`);
        //     };
        //     img.src = url;
        //   }


        // Set custom items including the new buttons
        toolbar.setItems([
          "zoomIn",
          "zoomOut",
          "fit",
          "recurse",
          "export"
        ]);

        toolbar.setBrand(false);  // Hide the "markmap" brand text
        const svgParent = svg.parentElement;
        if (svgParent && toolbar.el) {
          toolbar.el.style.position = 'absolute';
          toolbar.el.style.right = '20px';
          toolbar.el.style.bottom = '20px';
          toolbar.el.style.top = 'auto';
          toolbar.el.style.zIndex = '1000';
          svgParent.style.position = 'relative';
          svgParent.appendChild(toolbar.el);
        }
      }

      // Map button IDs to tooltip text
      // const tooltipTexts = {
      //   zoomIn: 'Zoom in_',
      //   zoomOut: 'Zoom out_',
      //   fit: 'Fit window size_',
      //   recurse: 'Toggle recursively_',
      //   export: 'Download SVG_'
      // };

      // // After toolbar is rendered:
      // const toolbarButtons = document.querySelectorAll('.mm-toolbar .mm-toolbar-item');
      // toolbarButtons.forEach(btn => {
      //   // Get the button's ID (set as data-id by Markmap)
      //   const id = btn.getAttribute('data-id');
      //   if (!id || !tooltipTexts[id]) return;

      //   btn.removeAttribute('title'); // Remove native tooltip

      //   btn.addEventListener('mouseenter', (e) => {
      //     toolbarTooltip.textContent = tooltipTexts[id];
      //     toolbarTooltip.style.display = 'block';
      //     const rect = btn.getBoundingClientRect();
      //     toolbarTooltip.style.left = rect.left + window.scrollX + 'px';
      //     toolbarTooltip.style.top = (rect.top + window.scrollY - toolbarTooltip.offsetHeight - 6) + 'px';
      //   });
      //   btn.addEventListener('mouseleave', () => {
      //     toolbarTooltip.style.display = 'none';
      //   });
      // });

      window.postMessage({ type: 'RENDER_MM_DONE', svgId, autoSize, fit, nodeMaxWidth }, '*');
    } catch (err) {
      console.error('[markmap-bridge]', err);
      window.postMessage({ type: 'RENDER_MM_ERROR', svgId, error: '' + err }, '*');
    }
  });
})();
