/**
 * Dashboard Aggregate Widgets — JARVIS Mission Control v1.16.0
 *
 * Polls APIs every 60s and updates the feature card row:
 *   🖥 Claude Sessions
 *   ⚡ CLI Connections
 *   🐙 GitHub Sync
 *   🔔 Webhook Health
 */

const WIDGET_POLL_MS = 60_000;

// ── Time helper ────────────────────────────────────────────────────────────

function _timeAgo(ts) {
    if (!ts) return '—';
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

// ── Feature card update helpers ────────────────────────────────────────────

function _setFCard(id, { main, mainClass, secondary, dot, time }) {
    const mainEl = document.getElementById(`fcard-${id}-main`);
    const secEl  = document.getElementById(`fcard-${id}-secondary`);
    const dotEl  = document.getElementById(`fcard-${id}-dot`);
    const timeEl = document.getElementById(`fcard-${id}-time`);

    if (mainEl) {
        mainEl.textContent = main !== undefined ? main : '—';
        mainEl.className = 'fcard-metric' + (mainClass ? ` ${mainClass}` : '');
    }
    if (secEl  && secondary !== undefined) secEl.textContent = secondary;
    if (dotEl  && dot) {
        dotEl.className = `fcard-status-dot ${dot}`;
    }
    if (timeEl && time !== undefined) timeEl.textContent = time;
}

// ── CLI Connections ────────────────────────────────────────────────────────

let _cliLastScan = null;

async function refreshCliWidget() {
    try {
        const res = await fetch('/api/connect');
        if (!res.ok) throw new Error('no data');
        const data = await res.json();
        _cliLastScan = new Date().toISOString();
        const list   = Array.isArray(data) ? data : (data.connections || []);
        const active = list.filter(c => c.status === 'active' || c.active).length;
        const total  = list.length;
        _setFCard('cli', {
            main: active,
            secondary: `${total} total registered`,
            dot: active > 0 ? 'healthy' : (total > 0 ? 'warning' : 'error'),
            time: `Last scan: ${_timeAgo(_cliLastScan)}`,
        });
    } catch {
        _setFCard('cli', { main: '?', secondary: 'unavailable', dot: 'error', time: 'Last scan: failed' });
    }
}

// ── GitHub Sync ────────────────────────────────────────────────────────────

let _githubLastScan = null;

async function refreshGithubWidget() {
    try {
        const res = await fetch('/api/tasks');
        if (!res.ok) throw new Error('no data');
        const tasks = await res.json();
        _githubLastScan = new Date().toISOString();
        const githubTasks = tasks.filter(t =>
            t.source === 'github' ||
            (Array.isArray(t.labels) && t.labels.some(l => String(l).toLowerCase().includes('github')))
        );
        const count = githubTasks.length;
        _setFCard('github', {
            main: count,
            secondary: 'synced issues',
            dot: count > 0 ? 'healthy' : 'warning',
            time: `Last sync: ${_timeAgo(_githubLastScan)}`,
        });
    } catch {
        _setFCard('github', { main: '?', secondary: 'unavailable', dot: 'error', time: 'Last sync: failed' });
    }
}

// ── Webhook Health ─────────────────────────────────────────────────────────

let _webhooksLastScan = null;

async function refreshWebhooksWidget() {
    try {
        const res = await fetch('/api/webhooks');
        if (!res.ok) throw new Error('no data');
        const webhooks = await res.json();
        _webhooksLastScan = new Date().toISOString();
        const total    = webhooks.length;
        const open     = webhooks.filter(w => w.circuitState === 'open').length;
        const halfOpen = webhooks.filter(w => w.circuitState === 'half-open').length;

        let dot = 'healthy';
        let mainClass = '';
        if (open > 0) { dot = 'error'; mainClass = 'error'; }
        else if (halfOpen > 0) { dot = 'warning'; mainClass = 'warning'; }

        _setFCard('webhooks', {
            main: total,
            mainClass,
            secondary: open > 0 ? `${open} open circuits` : (halfOpen > 0 ? `${halfOpen} half-open` : '0 open circuits'),
            dot,
            time: `Last scan: ${_timeAgo(_webhooksLastScan)}`,
        });
    } catch {
        _setFCard('webhooks', { main: '?', secondary: 'unavailable', dot: 'error', time: 'Last scan: failed' });
    }
}

// ── Poll all ───────────────────────────────────────────────────────────────

async function refreshAllWidgets() {
    await Promise.allSettled([
        refreshCliWidget(),
        refreshGithubWidget(),
        refreshWebhooksWidget(),
    ]);
}

// Initial load + periodic refresh
refreshAllWidgets();
setInterval(refreshAllWidgets, WIDGET_POLL_MS);
