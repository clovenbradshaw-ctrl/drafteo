// ============ MARKDOWN ============
// Minimal markdown ↔ HTML converter scoped to what DraftEO actually
// supports: headings, bold/italic/strike, links, blockquotes, lists,
// code (inline + block), hr, and the {{cite:N}} citation token.
//
// Not a full CommonMark implementation — this is the projection layer
// for the contentEditable surface. Round-trips well enough for the
// fold cache.

(function () {

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inlineFmt(s, footnoteMap) {
    // Escape first
    s = esc(s);
    // Inline code
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold + italic
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|\W)\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|\W)_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // Links
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // Citations
    s = s.replace(/\{\{cite:([^}]+)\}\}/g, function (_, id) {
      const fn = footnoteMap && footnoteMap[id];
      const archived = fn && fn.archived;
      const cls = 'cite' + (archived ? '' : ' unarchived');
      const n = fn ? fn.number : '?';
      return '<span class="' + cls + '" contenteditable="false" data-cite="' + esc(id) + '" data-num="' + n + '" title="Citation ' + n + (archived ? '' : ' (not archived)') + '">' + n + '</span>';
    });
    return s;
  }

  // Render the body markdown into rich HTML. `sources` and `footnotes`
  // come from the document state. Citation chips show the footnote
  // ordinal, computed left-to-right.
  function render(md, sources) {
    md = md || '';
    sources = sources || [];
    const lines = md.split(/\n/);

    // Build footnote ordering by first-appearance of {{cite:ID}} in source.
    const ordering = [];
    const seen = new Set();
    const re = /\{\{cite:([^}]+)\}\}/g;
    let m;
    while ((m = re.exec(md))) { if (!seen.has(m[1])) { ordering.push(m[1]); seen.add(m[1]); } }
    const footnoteMap = {};
    const srcById = {};
    for (const s of sources) srcById[s.source_id] = s;
    ordering.forEach((id, i) => {
      const src = srcById[id];
      footnoteMap[id] = {
        number: i + 1,
        source_id: id,
        archived: !!(src && src.archive_org_url),
        source: src,
      };
    });

    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      const fence = line.match(/^```(\w*)$/);
      if (fence) {
        const lang = fence[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^```$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // skip closing fence
        out.push('<pre data-lang="' + esc(lang) + '"><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // heading
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        out.push('<h' + h[1].length + '>' + inlineFmt(h[2], footnoteMap) + '</h' + h[1].length + '>');
        i++;
        continue;
      }

      // hr
      if (/^---+\s*$/.test(line)) { out.push('<hr/>'); i++; continue; }

      // blockquote
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + buf.map(l => inlineFmt(l, footnoteMap)).join('<br/>') + '</blockquote>');
        continue;
      }

      // unordered list
      if (/^[-*]\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          buf.push('<li>' + inlineFmt(lines[i].replace(/^[-*]\s+/, ''), footnoteMap) + '</li>');
          i++;
        }
        out.push('<ul>' + buf.join('') + '</ul>');
        continue;
      }

      // ordered list
      if (/^\d+\.\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          buf.push('<li>' + inlineFmt(lines[i].replace(/^\d+\.\s+/, ''), footnoteMap) + '</li>');
          i++;
        }
        out.push('<ol>' + buf.join('') + '</ol>');
        continue;
      }

      // blank line
      if (!line.trim()) { i++; continue; }

      // paragraph — gather until blank or special
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4} |>|---|\d+\.\s|[-*]\s|```)/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      out.push('<p>' + inlineFmt(buf.join(' '), footnoteMap) + '</p>');
    }

    return { html: out.join('\n'), footnoteMap, ordering };
  }

  // Convert the editor DOM tree back to markdown. Citation chips
  // become {{cite:ID}}. Walks the contentEditable subtree.
  function fromDom(root) {
    const out = [];
    for (const node of root.childNodes) blockToMd(node, out, 0);
    // collapse 3+ blank lines
    return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function blockToMd(node, out, depth) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.replace(/\s+/g, ' ');
      if (t.trim()) out.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
      const lvl = '#'.repeat(parseInt(tag[1], 10));
      out.push(lvl + ' ' + inlineToMd(node));
    } else if (tag === 'p' || tag === 'div') {
      const m = inlineToMd(node);
      if (m) out.push(m);
    } else if (tag === 'blockquote') {
      const m = inlineToMd(node);
      out.push(m.split('\n').map(l => '> ' + l).join('\n'));
    } else if (tag === 'ul' || tag === 'ol') {
      const lines = [];
      let idx = 1;
      for (const li of node.querySelectorAll(':scope > li')) {
        const prefix = tag === 'ul' ? '- ' : (idx++) + '. ';
        lines.push(prefix + inlineToMd(li));
      }
      out.push(lines.join('\n'));
    } else if (tag === 'pre') {
      const lang = node.dataset.lang || '';
      const code = node.textContent.replace(/\n+$/, '');
      out.push('```' + lang + '\n' + code + '\n```');
    } else if (tag === 'hr') {
      out.push('---');
    } else if (tag === 'br') {
      // skip — handled by line breaks
    } else {
      // fallback: treat as paragraph
      const m = inlineToMd(node);
      if (m) out.push(m);
    }
  }

  function inlineToMd(node) {
    let s = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        s += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (tag === 'strong' || tag === 'b') s += '**' + inlineToMd(child) + '**';
        else if (tag === 'em' || tag === 'i') s += '*' + inlineToMd(child) + '*';
        else if (tag === 'del' || tag === 's') s += '~~' + inlineToMd(child) + '~~';
        else if (tag === 'code') s += '`' + child.textContent + '`';
        else if (tag === 'a') s += '[' + inlineToMd(child) + '](' + (child.getAttribute('href') || '') + ')';
        else if (tag === 'br') s += '\n';
        else if (child.classList && child.classList.contains('cite')) {
          s += '{{cite:' + (child.dataset.cite || '') + '}}';
        } else {
          s += inlineToMd(child);
        }
      }
    }
    return s.replace(/[ \t]+/g, ' ').replace(/ \n/g, '\n').trim();
  }

  // Syntax-highlight the raw markdown view (very light touch).
  function highlightMarkdown(md) {
    md = esc(md);
    md = md.replace(/^(#{1,6} .*)$/gm, '<span class="md-h">$1</span>');
    md = md.replace(/(```[\s\S]*?```)/g, '<span class="md-fence">$1</span>');
    md = md.replace(/(\{\{cite:[^}]+\}\})/g, '<span class="md-cite">$1</span>');
    md = md.replace(/(\*[^*\n]+\*)/g, '<span class="md-em">$1</span>');
    return md;
  }

  window.MD = { render, fromDom, highlightMarkdown, esc };
})();
