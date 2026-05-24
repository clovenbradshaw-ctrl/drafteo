// ============ EO OPERATORS ============
// Lightweight classifier that picks an EO operator for a save based on
// the diff between the previous markdown and the new one. The categories
// are loosely those described in the build spec — INS, DES, SEG, CON,
// DEF, ROL — used as a human-readable audit trail rather than a formal
// CRDT log.

(function () {
  const OPS = {
    INS: { glyph: '△', name: 'Insertion', tone: 'INS' },
    DES: { glyph: '⊡', name: 'Excision',  tone: 'DES' },
    SEG: { glyph: '∥', name: 'Segment',   tone: 'SEG' },
    CON: { glyph: '⋈', name: 'Conjoin',   tone: 'CON' },
    DEF: { glyph: '⊢', name: 'Define',    tone: 'DEF' },
    ROL: { glyph: '↺', name: 'Rollback',  tone: 'ROL' },
  };

  function classify(prev, next) {
    const p = (prev || '').trim();
    const n = (next || '').trim();

    if (!p && n) {
      return { op: 'DEF', site: 'document', resolution: 'Initial body composed (' + wordCount(n) + ' words)' };
    }
    if (p && !n) {
      return { op: 'DES', site: 'document', resolution: 'Body cleared' };
    }

    const pWords = wordCount(p);
    const nWords = wordCount(n);
    const delta = nWords - pWords;

    // Heading-level changes → SEG
    const pH = (p.match(/^#{1,6} /gm) || []).length;
    const nH = (n.match(/^#{1,6} /gm) || []).length;
    if (pH !== nH) {
      return {
        op: 'SEG',
        site: 'headings',
        resolution: (nH > pH ? 'Added ' : 'Removed ') + Math.abs(nH - pH) + ' section heading' + (Math.abs(nH - pH) === 1 ? '' : 's'),
      };
    }

    // Citation-count changes → CON (citations conjoin sources to prose)
    const pC = (p.match(/\{\{cite:[^}]+\}\}/g) || []).length;
    const nC = (n.match(/\{\{cite:[^}]+\}\}/g) || []).length;
    if (pC !== nC) {
      return {
        op: 'CON',
        site: 'citations',
        resolution: (nC > pC ? 'Added ' : 'Removed ') + Math.abs(nC - pC) + ' citation' + (Math.abs(nC - pC) === 1 ? '' : 's'),
      };
    }

    if (delta > 0) {
      return { op: 'INS', site: bestSite(p, n), resolution: 'Inserted ' + delta + ' word' + (delta === 1 ? '' : 's') };
    }
    if (delta < 0) {
      return { op: 'DES', site: bestSite(p, n), resolution: 'Removed ' + (-delta) + ' word' + (delta === -1 ? '' : 's') };
    }
    return { op: 'INS', site: 'body', resolution: 'Minor edit' };
  }

  function wordCount(s) {
    return (s.match(/\b[\w'-]+\b/g) || []).length;
  }

  function bestSite(prev, next) {
    // Find the first paragraph index where prev and next diverge — useful
    // shorthand for showing where the change was.
    const a = prev.split(/\n{2,}/);
    const b = next.split(/\n{2,}/);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        const first = (b[i] || a[i] || '').replace(/[#>*`_-]+/g, '').trim().slice(0, 40);
        return 'paragraph ' + (i + 1) + (first ? ' — “' + first + (first.length === 40 ? '…' : '') + '”' : '');
      }
    }
    return 'body';
  }

  // Tiny line-diff for the diff viewer
  function diffLines(prev, next) {
    const a = (prev || '').split(/\n/);
    const b = (next || '').split(/\n/);
    const seen = new Set(a);
    const out = [];
    let ai = 0, bi = 0;
    while (ai < a.length && bi < b.length) {
      if (a[ai] === b[bi]) { out.push({ k: 'ctx', t: a[ai] }); ai++; bi++; }
      else if (!seen.has(b[bi])) { out.push({ k: 'add', t: b[bi] }); bi++; }
      else { out.push({ k: 'del', t: a[ai] }); ai++; }
    }
    while (ai < a.length) { out.push({ k: 'del', t: a[ai++] }); }
    while (bi < b.length) { out.push({ k: 'add', t: b[bi++] }); }
    // Compress long context runs
    const compressed = [];
    let ctxRun = 0;
    for (const line of out) {
      if (line.k === 'ctx') {
        ctxRun++;
        if (ctxRun <= 2) compressed.push(line);
        else if (ctxRun === 3) compressed.push({ k: 'ctx', t: '  …' });
      } else { ctxRun = 0; compressed.push(line); }
    }
    return compressed;
  }

  window.EO = { OPS, classify, diffLines, wordCount };
})();
