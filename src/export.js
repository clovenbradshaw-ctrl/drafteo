/**
 * export.js — Render a document for sharing.
 *
 * Both exporters take the doc's markdown body and a sources map
 * (anchor → source entity) and resolve every {{cite:ID}} token to a
 * numbered footnote, emitting a Citations block at the bottom.
 *
 *   exportMarkdown — Substack-flavored: [^n] + ^[n]: ... footnote defs
 *   exportHtml     — Standalone HTML with anchor links between refs and notes
 */

import { marked } from 'marked';

const CITE_RE = /\{\{cite:([^}]+)\}\}/g;

function collectCitations(body) {
  const order = [];
  const seen = new Map();
  body.replace(CITE_RE, (_, id) => {
    if (!seen.has(id)) {
      seen.set(id, order.length + 1);
      order.push(id);
    }
    return '';
  });
  return { order, seen };
}

function sourceLabel(src) {
  if (!src) return null;
  return src.title || src.filename || src.url || null;
}

function sourceUrl(src) {
  if (!src) return null;
  return src.archive_org_url || src.url || null;
}

export function exportMarkdown(body, sourcesMap = {}, meta = {}) {
  const { order, seen } = collectCitations(body || '');

  const replaced = (body || '').replace(CITE_RE, (_, id) => {
    const n = seen.get(id);
    return n ? `[^${n}]` : '';
  });

  const lines = [];
  if (meta.title) lines.push(`# ${meta.title}`, '');
  if (meta.dek)   lines.push(`*${meta.dek}*`, '');
  lines.push(replaced.trim());

  if (order.length > 0) {
    lines.push('', '---', '');
    for (const id of order) {
      const n = seen.get(id);
      const src = sourcesMap[id];
      const label = sourceLabel(src) || `(missing source ${id})`;
      const url = sourceUrl(src);
      const tail = url ? ` — ${url}` : (src ? ' — (not archived yet)' : '');
      lines.push(`[^${n}]: ${label}${tail}`);
    }
  }

  return lines.join('\n');
}

export function exportHtml(body, sourcesMap = {}, meta = {}) {
  const { order, seen } = collectCitations(body || '');

  const refReplaced = (body || '').replace(CITE_RE, (_, id) => {
    const n = seen.get(id);
    if (!n) return '';
    return `<sup id="fnref-${n}"><a href="#fn-${n}">[${n}]</a></sup>`;
  });

  const bodyHtml = marked.parse(refReplaced);

  let footnotes = '';
  if (order.length > 0) {
    const items = order.map((id) => {
      const n = seen.get(id);
      const src = sourcesMap[id];
      const label = escapeHtml(sourceLabel(src) || `(missing source ${id})`);
      const url = sourceUrl(src);
      const link = url ? ` — <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>` : '';
      return `<li id="fn-${n}">${label}${link} <a href="#fnref-${n}" aria-label="back to ref">↑</a></li>`;
    }).join('');
    footnotes = `<section class="footnotes"><h3>Citations</h3><ol>${items}</ol></section>`;
  }

  const titleHtml = meta.title ? `<h1>${escapeHtml(meta.title)}</h1>` : '';
  const dekHtml   = meta.dek   ? `<p class="dek"><em>${escapeHtml(meta.dek)}</em></p>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(meta.title || 'Document')}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 680px; margin: 40px auto; padding: 0 16px; color:#222; line-height:1.7; }
  h1, h2, h3 { font-family: Georgia, serif; }
  .dek { color:#555; }
  blockquote { border-left:3px solid #c4956a; padding:4px 14px; color:#555; margin:14px 0; }
  sup { font-size: 0.7em; }
  sup a { color:#c4956a; text-decoration:none; }
  .footnotes { border-top:1px solid #ddd; margin-top:36px; padding-top:14px; font-size:0.9em; color:#555; }
</style>
</head>
<body>
${titleHtml}${dekHtml}${bodyHtml}${footnotes}
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
