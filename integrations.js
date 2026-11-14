// ── Integrations (Settings → Integrations) ──
// Live health of every outside service the Hub talks to, from
// GET /api/integrations (functions/api/_integrations.js): one card each, with
// what it's used for, what was found and a Connect / Reconnect button where
// the service signs in with OAuth. Secrets are never shown, only whether set.

const Integrations = (() => {

    const STATUS = {
        ok:    ['Working',      'int-pill--ok'],
        warn:  ['Needs a look', 'int-pill--warn'],
        error: ['Not working',  'int-pill--err'],
        off:   ['Not set up',   'int-pill--off'],
    };

    function escHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    const timeNz = iso => new Date(iso).toLocaleTimeString('en-NZ', { timeZone: 'Pacific/Auckland', hour: 'numeric', minute: '2-digit' });

    // Messages for the OAuth round trips that land on #admin/integrations?…
    function noticeFrom(params) {
        if (!params) return null;
        if (params.get('xero_connected')) return { ok: true, text: 'Xero connected.' };
        if (params.get('gcal_connected')) return { ok: true, text: 'Google Calendar connected.' };
        const xe = params.get('xero_error');
        if (xe) {
            const hint = /invalid_scope/.test(xe)
                ? ' Xero refused one of the permissions the Hub asks for — the Xero app in developer.xero.com needs it enabled.'
                : /access_denied/.test(xe) ? ' The connection was cancelled in Xero.' : '';
            return { ok: false, text: 'Xero did not connect: ' + xe + '.' + hint };
        }
        const ge = params.get('gcal_error');
        if (ge) return { ok: false, text: 'Google Calendar did not connect: ' + ge + '.' };
        return null;
    }

    function cardHtml(i) {
        const [label, cls] = STATUS[i.status] || STATUS.error;
        const details = (i.details || []).map(d => `
            <div class="int-row">
                <span class="int-k">${escHtml(d.label)}</span>
                <span class="int-v">${escHtml(d.value)}${d.copy ? ` <button class="int-copy" data-copy="${escHtml(d.value)}" title="Copy">Copy</button>` : ''}</span>
            </div>`).join('');
        const perms = (i.permissions || []).length ? `
            <div class="int-perms">
                <div class="int-k">Permissions</div>
                ${i.permissions.map(p => `
                    <div class="int-perm ${p.granted === false ? 'int-perm--missing' : ''}">
                        <span class="int-perm-mark">${p.granted === true ? '✓' : p.granted === false ? '✕' : '·'}</span>
                        <span>${escHtml(p.purpose)}${p.granted === false ? ' <em>— not allowed yet</em>' : ''}</span>
                    </div>`).join('')}
            </div>` : '';
        const actions = (i.actions || []).map(a => a.href
            ? `<a class="${a.primary ? 'btn-primary' : 'btn-secondary'} btn-sm" href="${escHtml(a.href)}">${escHtml(a.label)}</a>`
            : `<button class="btn-secondary btn-sm" data-tab="${escHtml(a.tab)}">${escHtml(a.label)} →</button>`).join('');
        return `
            <div class="int-card int-card--${escHtml(i.status)}" id="int-${escHtml(i.id)}">
                <div class="int-head">
                    <h3 class="int-name">${escHtml(i.name)}</h3>
                    <span class="int-pill ${cls}">${label}</span>
                </div>
                <p class="int-summary">${escHtml(i.summary)}</p>
                ${i.usedFor ? `<p class="int-used">Used for: ${escHtml(i.usedFor)}</p>` : ''}
                ${details ? `<div class="int-details">${details}</div>` : ''}
                ${perms}
                ${actions ? `<div class="int-actions">${actions}</div>` : ''}
            </div>`;
    }

    function pageHtml(data, notice) {
        const s = data.summary || {};
        const groups = [];
        for (const i of data.integrations || []) {
            let g = groups.find(x => x.name === i.group);
            if (!g) groups.push(g = { name: i.group, items: [] });
            g.items.push(i);
        }
        return `
            ${notice ? `<div class="int-notice ${notice.ok ? 'int-notice--ok' : 'int-notice--err'}">${escHtml(notice.text)}</div>` : ''}
            <div class="int-bar">
                <span class="int-headline"><span class="int-dot int-dot--${escHtml(s.worst || 'ok')}"></span><strong>${escHtml(s.headline || '')}</strong></span>
                <span class="int-muted">checked ${escHtml(timeNz(data.checkedAt))}</span>
                <button class="btn-secondary btn-sm" id="int-recheck">Check again</button>
            </div>
            ${groups.map(g => `
                <h4 class="int-group">${escHtml(g.name)}</h4>
                <div class="int-grid">${g.items.map(cardHtml).join('')}</div>`).join('')}
            <p class="int-muted int-foot">Keys and tokens are set in Cloudflare Pages → Settings → Variables and secrets; this page only shows whether each one is set.</p>`;
    }

    async function renderSettingsTab(body, { params = null, switchTab = null } = {}) {
        let notice = noticeFrom(params);   // shown once, not on "Check again"
        const load = async () => {
            body.innerHTML = `<div class="orders-loading">Checking integrations…</div>`;
            let data;
            try {
                const resp = await fetch('/api/integrations');
                data = await resp.json().catch(() => null);
                if (!resp.ok || !data) throw new Error((data && data.error) || resp.statusText || 'No answer');
            } catch (e) {
                body.innerHTML = `<div class="cat-empty"><p><strong>Could not check the integrations.</strong></p><p style="color:#64748b">${escHtml(e.message)}</p></div>`;
                return;
            }
            body.innerHTML = `<div class="int">${pageHtml(data, notice)}</div>`;
            notice = null;
            body.querySelector('#int-recheck')?.addEventListener('click', load);
            body.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(btn.dataset.copy); showToast('Copied'); }
                catch { showToast('Copy failed — select and copy it instead'); }
            }));
            body.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => switchTab && switchTab(btn.dataset.tab)));
        };
        await load();
    }

    return { renderSettingsTab };
})();
