// ============ PDF RENDERER (pdf.js + text layer) ============
// Renders a PDF inline into a host element with a selectable text layer
// overlay so user highlights drive citation creation. Used by the source
// viewer and the source explorer in place of the browser's native PDF
// viewer (which can't share selections with the page).
//
// Public API:
//   window.PdfRender.render(host, url, opts) -> Promise<{ cancel, pageCount }>
//
//   host: HTMLElement to render pages into (will be cleared first)
//   url:  blob URL or remote URL of the PDF
//   opts: { onProgress?(pct, message), onPage?(pageNum) }
//
// Each rendered page is wrapped in a div.pdf-page[data-page="N"] so any
// selection handler can read the page number off the closest ancestor.

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

async function render(host, url, opts = {}) {
  if (!host) throw new Error('PdfRender.render needs a host element');
  if (!url) throw new Error('PdfRender.render needs a PDF url');
  // Clear host
  while (host.firstChild) host.removeChild(host.firstChild);
  host.classList.add('pdf-host');

  let cancelled = false;
  function cancel() { cancelled = true; }

  const loadingTask = pdfjsLib.getDocument({ url });
  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (e) {
    host.appendChild(makeError('Failed to load PDF: ' + (e.message || e)));
    return { cancel, pageCount: 0 };
  }
  if (cancelled) return { cancel, pageCount: 0 };

  const pageCount = pdf.numPages;
  const containerWidth = Math.max(320, host.clientWidth || host.offsetWidth || 800);

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    if (cancelled) break;
    try {
      const page = await pdf.getPage(pageNum);
      // Scale to fit the host width with a max cap.
      const baseViewport = page.getViewport({ scale: 1 });
      const targetWidth = Math.min(900, containerWidth - 32);
      const scale = targetWidth / baseViewport.width;
      const viewport = page.getViewport({ scale });

      const pageWrap = document.createElement('div');
      pageWrap.className = 'pdf-page';
      pageWrap.dataset.page = String(pageNum);
      pageWrap.style.width = viewport.width + 'px';
      pageWrap.style.height = viewport.height + 'px';

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      const outputScale = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';
      pageWrap.appendChild(canvas);

      const textLayerEl = document.createElement('div');
      textLayerEl.className = 'pdf-text-layer';
      pageWrap.appendChild(textLayerEl);

      host.appendChild(pageWrap);

      const ctx = canvas.getContext('2d');
      const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
      await page.render({ canvasContext: ctx, viewport, transform }).promise;
      if (cancelled) break;

      const textContent = await page.getTextContent();
      if (cancelled) break;

      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: textLayerEl,
        viewport,
      });
      await textLayer.render();

      if (opts.onPage) try { opts.onPage(pageNum); } catch (_) {}
      if (opts.onProgress) try { opts.onProgress(pageNum / pageCount, pageNum + ' / ' + pageCount); } catch (_) {}
    } catch (e) {
      console.warn('[pdfrender] page render failed', pageNum, e);
      host.appendChild(makeError('Page ' + pageNum + ' failed: ' + (e.message || e)));
    }
  }

  return { cancel, pageCount };
}

function makeError(msg) {
  const div = document.createElement('div');
  div.className = 'pdf-error';
  div.textContent = msg;
  return div;
}

// Walk up from a node to find the enclosing .pdf-page; return its page number
// (1-based) or null.
function pageOf(node) {
  while (node && node !== document) {
    if (node.classList && node.classList.contains('pdf-page')) {
      const n = parseInt(node.dataset.page, 10);
      return Number.isFinite(n) ? n : null;
    }
    node = node.parentNode;
  }
  return null;
}

window.PdfRender = { render, pageOf };
