// ============ WORKSPACE LIST + INVITE UI ============

(function () {
  const { el, mount, clear, fmtTimeAgo } = window.DOM;

  function render(root, app) {
    const session = Store.session();
    const grid = el('div.grid');
    const headStats = el('div.stats');

    const view = el('div.app',
      titlebar(session, app),
      el('div.projects',
        el('div.head',
          el('div',
            el('h2', greeting(session)),
            el('div.sub', 'Workspace · ' + (session.homeserver || '').replace(/^https?:\/\//, '') + ' · ' + session.device_id),
          ),
          headStats,
          el('div.actions',
            el('button.ghost', { onClick: () => openProfileModal(session, app) }, '✎ EDIT PROFILE'),
            el('button.primary', { onClick: () => openWorkspaceModal(null, app) }, '+ NEW WORKSPACE'),
          ),
        ),
        grid,
      ),
    );

    function rebuild() {
      clear(grid);
      clear(headStats);
      const ws = Store.listWorkspaces();
      const docCount = ws.reduce((n, w) => n + Store.listDocuments(w.id).length, 0);
      const srcCount = ws.reduce((n, w) => n + Store.listDocuments(w.id).reduce((m, d) => m + Store.listSources(d.id).length, 0), 0);
      const memCount = new Set(ws.flatMap(w => w.members.map(m => m.matrix_id))).size;
      headStats.appendChild(el('div', el('span.n', String(ws.length)), 'Workspaces'));
      headStats.appendChild(el('div', el('span.n', String(docCount)), 'Drafts'));
      headStats.appendChild(el('div', el('span.n', String(srcCount)), 'Sources'));
      headStats.appendChild(el('div', el('span.n', String(memCount)), 'People'));

      if (ws.length === 0) {
        grid.appendChild(emptyState(app));
      } else {
        for (const w of ws) grid.appendChild(workspaceCard(w, app, rebuild));
        grid.appendChild(addCard(app));
      }
    }

    rebuild();
    mount(root, view);

    // Live updates: a new invite arrives, or a collaborator creates a
    // workspace we're in — refresh the grid. Also re-paint when the
    // crypto self-test completes so the titlebar E2EE indicator settles
    // from "INITIALIZING" to "VERIFIED" / "FAILED". Auto-removes once
    // view detaches.
    const _refresh = () => {
      if (!document.contains(view)) {
        window.removeEventListener('drafteo:rooms-changed', _refresh);
        window.removeEventListener('drafteo:crypto-checked', _refresh);
        return;
      }
      // Re-render the titlebar in place so the E2EE chip reflects the
      // latest state.
      try {
        const newTitle = titlebar(Store.session(), app);
        const oldTitle = view.querySelector('.titlebar');
        if (oldTitle && newTitle) oldTitle.replaceWith(newTitle);
      } catch (_) {}
      rebuild();
    };
    window.addEventListener('drafteo:rooms-changed', _refresh);
    window.addEventListener('drafteo:crypto-checked', _refresh);
  }

  function titlebar(session, app) {
    return el('div.titlebar',
      el('div.brand', el('span.mark'), el('span', 'DraftEO')),
      el('div.crumbs',
        el('span.current', 'Workspaces'),
      ),
      el('div.spacer'),
      el('div.statusdot.saved',
        { title: e2eeTitle() },
        el('span.dot'),
        el('span', e2eeLabel()),
      ),
      el('div.userchip',
        el('span.av', initials(session.matrix_id)),
        el('span', { style: { maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis' } }, session.matrix_id),
        el('button.ghost', { style: { padding: '1px 6px', fontSize: '10px', marginLeft: '6px' }, onClick: () => app.logout() }, 'LOGOUT'),
      ),
    );
  }

  function e2eeSelfTest() {
    try { return window.MX && window.MX.getCryptoSelfTest && window.MX.getCryptoSelfTest(); }
    catch (_) { return null; }
  }
  function e2eeLabel() {
    const t = e2eeSelfTest();
    if (!t) return 'E2EE · INITIALIZING';
    return t.ok ? 'E2EE · VERIFIED' : 'E2EE · FAILED';
  }
  function e2eeTitle() {
    const t = e2eeSelfTest();
    if (!t) return 'Megolm self-test pending.';
    if (t.ok) return 'Megolm encrypt/decrypt round-trip verified (' + t.algorithm + '). The homeserver only sees ciphertext.';
    return 'Megolm self-test FAILED: ' + (t.reason || 'unknown') + '. New writes may not be E2EE — investigate before continuing.';
  }

  function greeting(session) {
    const h = new Date().getHours();
    const tod = h < 5 ? 'Late evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = (session.display_name || session.matrix_id || '').replace(/^@/, '').split(':')[0];
    return tod + ', ' + name + '.';
  }

  function openProfileModal(session, app) {
    const display = el('input', { type: 'text', value: session.display_name || '', placeholder: 'Your display name' });
    const mid = el('input', { type: 'text', value: session.matrix_id || '', disabled: true });
    const homeserver = el('input', { type: 'text', value: session.homeserver || '', disabled: true });

    const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) close(); } });
    function close() { scrim.remove(); }

    async function submit() {
      const newName = display.value.trim();
      if (!newName) { display.focus(); return; }
      session.display_name = newName;
      try { localStorage.setItem('drafteo.v1', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('drafteo.v1') || '{}'), { session }))); } catch (_) {}
      close();
      render(document.getElementById('root'), app);
    }

    const modal = el('div.modal', { onClick: (e) => e.stopPropagation() },
      el('div.m-head',
        el('div', el('div.ttl', 'Edit profile'), el('div.sub', 'Display name only — your Matrix ID is fixed by your homeserver')),
        el('button.ghost', { onClick: close }, '✕'),
      ),
      el('div.m-body',
        el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--ink-faint)', marginBottom: '6px' } }, 'Display name'),
        display,
        el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--ink-faint)', margin: '16px 0 6px' } }, 'Matrix ID'),
        mid,
        el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--ink-faint)', margin: '16px 0 6px' } }, 'Homeserver'),
        homeserver,
        el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-faint)', marginTop: '14px', lineHeight: '1.7' } },
          'Your Matrix ID and homeserver are set at sign-in and can\'t be changed here. ',
          'To use a different account, log out and sign back in.',
        ),
      ),
      el('div.m-foot',
        el('div'),
        el('div.actions',
          el('button.ghost', { onClick: close }, 'CANCEL'),
          el('button.primary', { onClick: submit }, 'SAVE'),
        ),
      ),
    );
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    setTimeout(() => display.focus(), 60);
  }

  function initials(mid) {
    const name = (mid || '').replace(/^@/, '').split(':')[0];
    return (name.slice(0, 2) || '??').toUpperCase();
  }

  function emptyState(app) {
    return el('div.empty-state',
      el('div.glyph', '⊢'),
      el('h3', 'Nothing here yet.'),
      el('p',
        'A workspace is your Matrix space — end-to-end encrypted, shared only with people you invite. ',
        'Drop drafts inside it, attach source documents, and publish them to the Internet Archive when you’re ready.'
      ),
      el('button.primary', { onClick: () => openWorkspaceModal(null, app), style: { padding: '11px 20px' } },
        'CREATE YOUR FIRST WORKSPACE'),
    );
  }

  function workspaceCard(w, app, rebuild) {
    const docs = Store.listDocuments(w.id);
    const sources = docs.reduce((n, d) => n + Store.listSources(d.id).length, 0);
    const joined = w.members.filter(m => m.status === 'joined');
    const invited = w.members.filter(m => m.status === 'invited');
    return el('div.projcard',
      { onClick: (e) => { if (e.target.closest('button,.docrow,.member-clickable')) return; app.openWorkspace(w.id); } },
      el('div.row',
        el('span', { title: 'Updated ' + new Date(w.updated_at).toLocaleString() }, fmtTimeAgo(w.updated_at)),
        el('div', { style: { display: 'flex', gap: '6px' } },
          w.e2ee ? el('span.badge', { style: { color: 'var(--ok)', borderColor: 'rgba(107,153,97,0.4)' } }, '⊕ E2EE') : null,
          el('span.badge', joined.length === 1 ? 'PRIVATE' : (joined.length + ' MEMBERS')),
        ),
      ),
      el('h3', w.title),
      el('p', w.description || el('em', { style: { color: 'var(--ink-faint)' } }, 'No description.')),
      el('div.footer',
        el('div.docs',
          el('strong', String(docs.length)), ' draft' + (docs.length === 1 ? '' : 's'),
          ' · ',
          el('strong', String(sources)), ' source' + (sources === 1 ? '' : 's'),
        ),
        el('div.members',
          ...joined.slice(0, 4).map(m => el('div.av', { title: m.matrix_id + ' · ' + m.role }, initials(m.matrix_id))),
          invited.length > 0 ? el('div.av', { style: { background: 'var(--chrome-3)', color: 'var(--warn)', border: '1px dashed var(--warn)' }, title: invited.length + ' invited' }, '+' + invited.length) : null,
          el('button.ghost.member-clickable',
            { style: { padding: '0', width: '22px', height: '22px', marginLeft: '4px', fontSize: '12px' }, onClick: () => openInviteModal(w, app, rebuild), title: 'Invite by Matrix ID' },
            '+'),
        ),
      ),
      el('div.projcard-cta',
        el('button.primary.cta-big', { onClick: () => app.openWorkspace(w.id) }, 'OPEN WORKSPACE →'),
        el('button.ghost', { onClick: (e) => { e.stopPropagation(); openWorkspaceSettings(w, app, rebuild); } }, '⚙'),
      ),
    );
  }

  function addCard(app) {
    return el('div.projcard.new-card', { onClick: () => openWorkspaceModal(null, app) },
      el('div', { style: { textAlign: 'center' } },
        el('div.plus', '+'),
        el('div', { style: { textTransform: 'uppercase', letterSpacing: '0.16em', fontSize: '10px', marginTop: '6px' } }, 'New workspace'),
      ),
    );
  }

  // ============ workspace detail (drawer-style page) ============
  function openWorkspace(w, app, rebuildParent) {
    const drawer = el('div.scrim', { onClick: (e) => { if (e.target === drawer) close(); } });
    function close() { drawer.remove(); rebuildParent(); }

    const docList = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '8px' } });
    const memberList = el('div');

    function rebuild() {
      clear(docList);
      const docs = Store.listDocuments(w.id);
      if (docs.length === 0) {
        docList.appendChild(el('div', { style: { padding: '20px', color: 'var(--ink-faint)', fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: '13px', textAlign: 'center', border: '1px dashed var(--border)' } }, 'No drafts yet.'));
      } else {
        for (const d of docs) {
          docList.appendChild(el('div.docrow', { style: { padding: '8px 10px', borderBottom: '1px solid var(--border)' }, onClick: () => { drawer.remove(); app.openDocument(w.id, d.id); } },
            el('div.ico', '§'),
            el('div.ttl', d.title),
            el('div.meta', fmtTimeAgo(d.updated_at)),
            el('div.ver', 'v' + d.version),
          ));
        }
      }
      clear(memberList);
      memberList.appendChild(membersTable(w, rebuild));
    }

    const modal = el('div.modal', { style: { width: 'min(640px, 96vw)' }, onClick: e => e.stopPropagation() },
      el('div.m-head',
        el('div',
          el('div.ttl', w.title),
          el('div.sub', 'Workspace · ' + (w.e2ee ? 'E2EE' : 'unencrypted') + ' · ' + w.members.length + ' member' + (w.members.length === 1 ? '' : 's')),
        ),
        el('button.ghost', { onClick: close }, '✕'),
      ),
      el('div.m-body',
        w.description ? el('div', { style: { fontFamily: 'var(--serif)', color: 'var(--ink-dim)', fontSize: '13px', marginBottom: '14px', lineHeight: '1.6' } }, w.description) : null,
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' } },
          el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--ink-faint)' } }, 'Drafts'),
          el('button.ghost', { style: { fontSize: '10px' }, onClick: () => openNewDocModal(w, app, () => { rebuild(); }) }, '+ NEW DRAFT'),
        ),
        docList,
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px' } },
          el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--ink-faint)' } }, 'Members & invitations'),
          el('button.ghost', { style: { fontSize: '10px' }, onClick: () => openInviteModal(w, app, rebuild) }, '+ INVITE'),
        ),
        memberList,
      ),
      el('div.m-foot',
        el('button.ghost', { onClick: async () => {
          if (!confirm('Delete workspace "' + w.title + '" and all its drafts? Cannot be undone.')) return;
          await Store.deleteWorkspace(w.id);
          close();
        }, style: { color: 'var(--err)' } }, 'DELETE WORKSPACE'),
        el('div.actions',
          el('button.ghost', { onClick: close }, 'CLOSE'),
        ),
      ),
    );

    drawer.appendChild(modal);
    document.body.appendChild(drawer);
    rebuild();
  }

  function membersTable(w, refresh) {
    const wrap = el('div', { style: { marginTop: '8px' } });
    for (const m of w.members) {
      const role = el('select', { onChange: async (e) => { await Store.updateMember(w.id, m.matrix_id, { role: e.target.value }); refresh(); } },
        ...['owner', 'editor', 'commenter', 'viewer'].map(r => {
          const o = el('option', { value: r, selected: m.role === r }, r.toUpperCase());
          return o;
        })
      );
      if (m.matrix_id === w.owner) role.disabled = true;

      wrap.appendChild(el('div.member-row',
        el('div.av' + (m.status === 'invited' ? '.pending' : ''), initials(m.matrix_id)),
        el('div',
          el('div.mid', m.matrix_id),
          el('div.sub',
            m.status === 'invited' ? 'INVITED · ' + fmtTimeAgo(m.invited_at) : 'JOINED · ' + fmtTimeAgo(m.joined_at),
            m.matrix_id === w.owner ? ' · OWNER' : '',
          ),
        ),
        role,
        m.matrix_id === w.owner
          ? el('div', { style: { color: 'var(--ink-faint)', fontSize: '10px', textAlign: 'right' } }, '—')
          : el('button.ghost.remove', { onClick: async () => { await Store.removeMember(w.id, m.matrix_id); refresh(); }, style: { textAlign: 'right' } }, 'REMOVE'),
      ));
    }
    return wrap;
  }

  // ============ modals ============
  function openWorkspaceModal(existing, app) {
    const title = el('input', { type: 'text', placeholder: 'e.g. Beacon Investigation', value: existing ? existing.title : '' });
    const desc = el('textarea', { placeholder: 'Optional — what is this workspace about?', rows: 3 }, existing ? existing.description : '');
    const inviteList = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' } });
    const pending = [];

    const inviteInput = el('input', { type: 'text', placeholder: '@user:hyphae.social', onKeydown: (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addPending(); }
    } });
    const inviteRole = el('select',
      el('option', { value: 'editor' }, 'EDITOR'),
      el('option', { value: 'commenter' }, 'COMMENTER'),
      el('option', { value: 'viewer' }, 'VIEWER'),
      el('option', { value: 'owner' }, 'CO-OWNER'),
    );
    const inviteErr = el('div', { style: { color: 'var(--err)', fontSize: '10px', fontFamily: 'var(--mono)', minHeight: '12px', marginTop: '4px' } });

    function addPending() {
      inviteErr.textContent = '';
      const raw = inviteInput.value.trim();
      if (!raw) return;
      const cleaned = Store.normalizeMatrixId(raw);
      if (!cleaned) { inviteErr.textContent = 'Enter a Matrix ID like @user:hyphae.social'; return; }
      if (pending.find(p => p.matrix_id === cleaned)) { inviteErr.textContent = 'Already in invite list.'; return; }
      pending.push({ matrix_id: cleaned, role: inviteRole.value });
      inviteInput.value = '';
      renderPending();
    }
    function renderPending() {
      clear(inviteList);
      for (const p of pending) {
        inviteList.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', background: 'var(--chrome-2)', border: '1px solid var(--border)' } },
          el('span', { style: { fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--ink)', flex: 1 } }, p.matrix_id),
          el('span', { style: { fontSize: '9px', fontFamily: 'var(--mono)', color: 'var(--accent-soft)', textTransform: 'uppercase', letterSpacing: '0.14em' } }, p.role),
          el('button.ghost', { style: { padding: '0 6px', fontSize: '10px' }, onClick: () => { pending.splice(pending.indexOf(p), 1); renderPending(); } }, '✕'),
        ));
      }
      if (pending.length === 0) {
        inviteList.appendChild(el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-faint)', padding: '6px 0' } }, 'No one yet — add Matrix IDs above and press Enter.'));
      }
    }
    renderPending();

    const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) close(); } });
    function close() { scrim.remove(); }

    async function submit() {
      const t = title.value.trim();
      if (!t) { title.focus(); return; }
      addPending(); // commit any text still in the input
      let ws;
      if (existing) ws = await Store.updateWorkspace(existing.id, { title: t, description: desc.value.trim() });
      else ws = await Store.createWorkspace({ title: t, description: desc.value.trim() });
      for (const p of pending) {
        try { await Store.inviteMember(ws.id, p.matrix_id, p.role); } catch (e) { /* skip dupes etc */ }
      }
      close();
      render(document.getElementById('root'), app);
    }

    const modal = el('div.modal', { onClick: e => e.stopPropagation() },
      el('div.m-head',
        el('div', el('div.ttl', existing ? 'Edit workspace' : 'New workspace'), el('div.sub', 'Matrix space · E2EE on')),
        el('button.ghost', { onClick: close }, '✕'),
      ),
      el('div.m-body',
        el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--ink-faint)', marginBottom: '6px' } }, 'Title'),
        title,
        el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--ink-faint)', margin: '16px 0 6px' } }, 'Description'),
        desc,
        existing ? null : el('div', { style: { marginTop: '18px' } },
          el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--ink-faint)', marginBottom: '6px' } }, 'Invite people (optional)'),
          el('div', { style: { display: 'flex', gap: '6px' } },
            inviteInput,
            inviteRole,
            el('button.ghost', { onClick: addPending, style: { whiteSpace: 'nowrap' } }, '+ ADD'),
          ),
          inviteErr,
          inviteList,
          el('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-faint)', marginTop: '6px', lineHeight: '1.6' } },
            'They\'ll get a Matrix invite to this E2EE space. ',
            'You can add or remove people anytime later.'),
        ),
        el('div', { style: { display: 'flex', gap: '10px', marginTop: '18px', alignItems: 'center', padding: '10px 12px', border: '1px solid rgba(107,153,97,0.3)', color: 'var(--ok)', fontFamily: 'var(--mono)', fontSize: '11px' } },
          el('span', '⊕'),
          el('span', 'End-to-end encrypted. Only invited members can read content.'),
        ),
      ),
      el('div.m-foot',
        el('div', { style: { color: 'var(--ink-faint)', fontSize: '10px', fontFamily: 'var(--mono)' } }, 'Creates a Matrix space inside your account.'),
        el('div.actions',
          el('button.ghost', { onClick: close }, 'CANCEL'),
          el('button.primary', { onClick: submit }, existing ? 'SAVE' : 'CREATE'),
        ),
      ),
    );
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    setTimeout(() => title.focus(), 60);
  }

  function openNewDocModal(workspace, app, onDone) {
    const title = el('input', { type: 'text', placeholder: 'Draft title' });
    const dek = el('input', { type: 'text', placeholder: 'Optional standfirst / dek' });
    const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) close(); } });
    function close() { scrim.remove(); }
    async function submit() {
      const t = title.value.trim();
      if (!t) { title.focus(); return; }
      const d = await Store.createDocument(workspace.id, { title: t, dek: dek.value.trim() });
      close();
      if (onDone) onDone();
      app.openDocument(workspace.id, d.id);
    }
    const modal = el('div.modal', { onClick: e => e.stopPropagation() },
      el('div.m-head', el('div', el('div.ttl', 'New draft'), el('div.sub', workspace.title)), el('button.ghost', { onClick: close }, '✕')),
      el('div.m-body',
        el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--ink-faint)', marginBottom: '6px' } }, 'Title'),
        title,
        el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--ink-faint)', margin: '16px 0 6px' } }, 'Standfirst (optional)'),
        dek,
      ),
      el('div.m-foot',
        el('div'),
        el('div.actions',
          el('button.ghost', { onClick: close }, 'CANCEL'),
          el('button.primary', { onClick: submit }, 'CREATE DRAFT'),
        ),
      ),
    );
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    setTimeout(() => title.focus(), 60);
  }

  function openInviteFromTopbar(app) {
    const ws = Store.listWorkspaces();
    if (ws.length === 0) { DOM.toast('NO WORKSPACE', 'Create a workspace first.'); return; }
    openInviteModal(ws[0], app, () => render(document.getElementById('root'), app));
  }

  function openInviteModal(workspace, app, refresh) {
    const mid = el('input', { type: 'text', placeholder: '@user:hyphae.social' });
    const err = el('div', { style: { color: 'var(--err)', fontSize: '11px', fontFamily: 'var(--mono)', minHeight: '14px', marginTop: '6px' } });
    let role = 'editor';
    const ROLES = [
      ['viewer',    'Viewer',    'Can read the draft and its sources. No comments.'],
      ['commenter', 'Commenter', 'Can comment and suggest edits. Cannot accept or change body.'],
      ['editor',    'Editor',    'Full read/write. Can accept suggestions, archive sources.'],
      ['owner',     'Co-owner',  'Editor + can manage members and delete workspace.'],
    ];
    const radios = ROLES.map(([key, lbl, desc]) => {
      const r = el('div.role-radio' + (key === role ? '.checked' : ''),
        { onClick: () => { role = key; radios.forEach((x, i) => x.classList.toggle('checked', ROLES[i][0] === key)); } },
        el('div.lbl', lbl),
        el('div.desc', desc),
      );
      return r;
    });

    const scrim = el('div.scrim', { onClick: (e) => { if (e.target === scrim) close(); } });
    function close() { scrim.remove(); }
    async function submit() {
      err.textContent = '';
      try {
        await Store.inviteMember(workspace.id, mid.value, role);
        DOM.toast('INVITE SENT', mid.value);
        close();
        if (refresh) refresh();
      } catch (e) { err.textContent = e.message || String(e); }
    }

    const modal = el('div.modal', { onClick: e => e.stopPropagation() },
      el('div.m-head', el('div', el('div.ttl', 'Invite to ' + workspace.title), el('div.sub', 'Matrix invitation · E2EE')), el('button.ghost', { onClick: close }, '✕')),
      el('div.m-body',
        el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--ink-faint)', marginBottom: '6px' } }, 'Matrix ID'),
        mid,
        err,
        el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--ink-faint)', margin: '16px 0 6px' } }, 'Role'),
        ...radios,
      ),
      el('div.m-foot', el('div'),
        el('div.actions',
          el('button.ghost', { onClick: close }, 'CANCEL'),
          el('button.primary', { onClick: submit }, 'SEND INVITE'),
        ),
      ),
    );
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    setTimeout(() => mid.focus(), 60);
  }

  // Expose for shell access
  function openWorkspaceSettings(ws, app, refresh) {
    // Open detail drawer (reuse old openWorkspace flow) — but rename to avoid clash
    const drawer = document.createElement('div');
    drawer.dispatchEvent;
    legacyDetail(ws, app, refresh || (() => render(document.getElementById('root'), app)));
  }

  function legacyDetail(w, app, rebuildParent) {
    // (preserved from the old behaviour)
    const drawer = el('div.scrim', { onClick: (e) => { if (e.target === drawer) close(); } });
    function close() { drawer.remove(); rebuildParent && rebuildParent(); }
    const memberList = el('div');
    function rebuild() {
      clear(memberList);
      memberList.appendChild(membersTable(w, rebuild));
    }
    const modal = el('div.modal', { style: { width: 'min(560px, 96vw)' }, onClick: e => e.stopPropagation() },
      el('div.m-head',
        el('div', el('div.ttl', w.title), el('div.sub', 'Workspace settings · E2EE')),
        el('button.ghost', { onClick: close }, '✕'),
      ),
      el('div.m-body',
        w.description ? el('div', { style: { fontFamily: 'var(--sans)', color: 'var(--ink-dim)', fontSize: '13px', marginBottom: '14px', lineHeight: '1.6' } }, w.description) : null,
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' } },
          el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--ink-faint)' } }, 'Members & invitations'),
          el('button.ghost', { style: { fontSize: '10px' }, onClick: () => openInviteModal(w, app, rebuild) }, '+ INVITE'),
        ),
        memberList,
      ),
      el('div.m-foot',
        el('button.ghost', { onClick: async () => {
          if (!confirm('Delete workspace "' + w.title + '" and all its drafts? Cannot be undone.')) return;
          await Store.deleteWorkspace(w.id);
          close();
        }, style: { color: 'var(--err)' } }, 'DELETE WORKSPACE'),
        el('div.actions', el('button.ghost', { onClick: close }, 'CLOSE')),
      ),
    );
    drawer.appendChild(modal);
    document.body.appendChild(drawer);
    rebuild();
  }

  // Expose for the workspace shell
  window.WorkspaceView = {
    render,
    openSettings: (ws, app, refresh) => openWorkspaceSettings(ws, app, refresh),
    openInvite:   (ws, app, refresh) => openInviteModal(ws, app, refresh),
  };
})();
