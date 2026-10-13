// Email Test Service dashboard. Email content is always rendered with textContent (or in a sandboxed iframe),
// never injected as HTML into this page.

let messages = [];
let currentPage = 1;
let pageSize = 10;
let totalPages = 1;
let selectedId = null;

const $ = id => document.getElementById(id);

// --- Utilities ---

// fetch wrapper: marks requests as same-origin script calls (required by the server for
// cookie-authenticated writes) and sends the user to the login page when the session expires
async function apiFetch(url, options = {}) {
    const headers = { 'X-Requested-With': 'fetch', ...(options.headers || {}) };
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
        window.location.href = '/login.html';
        throw new Error('Not authenticated');
    }
    return response;
}

function readSetting(key, fallback) {
    try {
        return localStorage.getItem(key) || fallback;
    } catch {
        return fallback;
    }
}

function saveSetting(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // storage unavailable: the setting just isn't remembered
    }
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function formatMessageTime(timestamp) {
    const msgDate = new Date(timestamp);
    const diffMin = Math.floor((Date.now() - msgDate) / 60000);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);
    if (diffMin < 1) return 'Just now';
    if (diffHr < 1) return `${diffMin} min ago`;
    if (diffDay < 1) return `${diffHr} h ago`;
    if (diffDay < 7) return `${diffDay} d ago`;
    return msgDate.toLocaleDateString();
}

// Converts a YYYY-MM-DD value from a date input to an ISO timestamp for local midnight
// (optionally the following midnight, so the end date is inclusive)
function localDayToIso(value, nextDay = false) {
    if (!value) return '';
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d + (nextDay ? 1 : 0)).toISOString();
}

// --- Quick time ranges (sidebar) ---

const MINUTE = 60 * 1000;
const RANGES = {
    '10m': { ms: 10 * MINUTE, label: 'Last 10 minutes' },
    '1h': { ms: 60 * MINUTE, label: 'Last 1 hour' },
    '8h': { ms: 8 * 60 * MINUTE, label: 'Last 8 hours' },
    '24h': { ms: 24 * 60 * MINUTE, label: 'Last 1 day' },
    '7d': { ms: 7 * 24 * 60 * MINUTE, label: 'Last 1 week' },
    '30d': { ms: 30 * 24 * 60 * MINUTE, label: 'Last 1 month' },
};
let timeRange = 'all'; // a RANGES key, 'all', or 'custom' (dates picked in the toolbar)

// Keeps the sidebar dropdown and the header chip in sync with the current range
function renderRange() {
    $('rangeSelect').value = timeRange;
    const range = RANGES[timeRange];
    $('rangeChip').classList.toggle('hidden', !range);
    $('rangeChipText').textContent = range ? range.label : '';
    $('rangeIconButton').classList.toggle('active', timeRange !== 'all');
}

async function setTimeRange(value) {
    timeRange = RANGES[value] ? value : 'all';
    // A quick range replaces any picked dates
    $('startDate').value = '';
    $('endDate').value = '';
    renderRange();
    if (currentView() !== 'messages') location.hash = '#/messages';
    else await filterMessages();
}

async function copyText(text, button) {
    const original = button.textContent;
    try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
    } catch {
        button.textContent = 'Copy failed';
    }
    setTimeout(() => (button.textContent = original), 1500);
}

// --- Navigation ---

const VIEWS = ['messages', 'send', 'keys', 'api'];
const VIEW_TITLES = { messages: 'Emails', send: 'Send test', keys: 'API keys', api: 'Setup & API' };

function currentView() {
    const name = location.hash.replace(/^#\/?/, '');
    if (userRole === 'viewer' && ADMIN_VIEWS.includes(name)) {
        history.replaceState(null, '', '#/messages'); // keep the address bar honest
        return 'messages';
    }
    return VIEWS.includes(name) ? name : 'messages';
}

function showView() {
    const view = currentView();
    document.querySelectorAll('.view').forEach(section => section.classList.toggle('hidden', section.dataset.view !== view));
    document.querySelectorAll('.sidebar-nav .nav-link').forEach(link => {
        const active = link.dataset.view === view;
        link.classList.toggle('active', active);
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    });
    document.title = `${VIEW_TITLES[view]} · Email Test Service`;
    if (view === 'messages') reloadWithSavedParams();
    if (view === 'send') $('toInput').value ? $('subjectInput').focus() : $('toInput').focus();
    if (view === 'keys') loadKeys();
    else forgetRevealedKeys();
}

function setSidebarCollapsed(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    const button = $('collapseButton');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    button.setAttribute('aria-label', button.title);
    saveSetting('mail_sidebar_collapsed', collapsed ? 'yes' : 'no');
}

// --- Resizable sidebar ---

const SIDEBAR_DEFAULT = 232;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 400;
const SIDEBAR_COLLAPSE_AT = 120; // dragging narrower than this collapses to icons

function applySidebarWidth(px) {
    document.documentElement.style.setProperty('--sidebar-width', `${px}px`);
    $('sidebarResizer').setAttribute('aria-valuenow', String(px));
    // The message pane's width is a share of the remaining space, so let it re-measure
    window.dispatchEvent(new Event('resize'));
}

// Applied as soon as the script runs, before the first paint, so the sidebar doesn't jump
(function restoreSidebarWidth() {
    const saved = parseInt(readSetting('mail_sidebar_width', ''), 10);
    if (saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) {
        document.documentElement.style.setProperty('--sidebar-width', `${saved}px`);
    }
})();

function initSidebarResizer() {
    const handle = $('sidebarResizer');
    // The target width (CSS variable), not the measured one, which lags while the width animates
    const current = () =>
        parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || SIDEBAR_DEFAULT;
    const clamp = px => Math.min(Math.max(Math.round(px), SIDEBAR_MIN), SIDEBAR_MAX);
    handle.setAttribute('aria-valuemin', String(SIDEBAR_MIN));
    handle.setAttribute('aria-valuemax', String(SIDEBAR_MAX));
    handle.setAttribute('aria-valuenow', String(current()));

    handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing');
        const left = $('sidebar').getBoundingClientRect().left;
        let width = current();
        let wantsCollapse = false;
        let frame = 0;
        const onMove = moveEvent => {
            const raw = moveEvent.clientX - left;
            wantsCollapse = raw < SIDEBAR_COLLAPSE_AT;
            handle.classList.toggle('will-collapse', wantsCollapse);
            width = clamp(raw);
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => applySidebarWidth(width));
        };
        const onUp = () => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            document.body.classList.remove('resizing');
            handle.classList.remove('will-collapse');
            if (wantsCollapse) {
                // Keep the last expanded width for when the sidebar is expanded again
                applySidebarWidth(clamp(parseInt(readSetting('mail_sidebar_width', ''), 10) || SIDEBAR_DEFAULT));
                setSidebarCollapsed(true);
            } else {
                saveSetting('mail_sidebar_width', String(width));
            }
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    });
    // Keyboard: arrow keys resize in 16px steps
    handle.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const width = clamp(current() + (event.key === 'ArrowRight' ? 16 : -16));
        applySidebarWidth(width);
        saveSetting('mail_sidebar_width', String(width));
    });
    handle.addEventListener('dblclick', () => {
        applySidebarWidth(SIDEBAR_DEFAULT);
        saveSetting('mail_sidebar_width', String(SIDEBAR_DEFAULT));
    });
}

// The signed-in account's role: 'admin' or 'viewer'. Viewers only see messages; the server
// enforces this too, the dashboard just hides what they can't use.
let userRole = 'admin';
const ADMIN_VIEWS = ['send', 'keys'];

async function loadSession() {
    try {
        const response = await fetch('/auth/status');
        const status = await response.json();
        userRole = status.role === 'viewer' ? 'viewer' : 'admin';
        const name = status.username || (status.authDisabled ? 'No sign-in' : 'admin');
        $('currentUser').textContent = userRole === 'viewer' ? `${name} (viewer)` : name;
        $('authWarning').classList.toggle('hidden', !status.authDisabled);
        $('logoutButton').classList.toggle('hidden', Boolean(status.authDisabled));
    } catch {
        // keep defaults
    }
    document.body.classList.toggle('role-viewer', userRole === 'viewer');
}

async function logout() {
    try {
        await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
        window.location.href = '/login.html';
    }
}

// --- Emails: loading and rendering ---

function currentFilters() {
    return {
        searchInput: $('searchInput').value,
        startDate: $('startDate').value,
        endDate: $('endDate').value,
    };
}

async function loadMessages(page = 1, pageSizeParam = pageSize, searchInput = '', startDate = '', endDate = '') {
    saveSetting('mail_query_params', JSON.stringify({ page, pageSize: pageSizeParam, searchInput, startDate, endDate, timeRange }));
    try {
        const queryParams = new URLSearchParams({ page, pageSize: pageSizeParam });
        if (searchInput) queryParams.set('search', searchInput);
        if (startDate) queryParams.set('after', localDayToIso(startDate));
        if (endDate) queryParams.set('before', localDayToIso(endDate, true));
        // Relative ranges are recalculated on every load, so the window keeps sliding
        if (!startDate && !endDate && RANGES[timeRange]) {
            queryParams.set('after', new Date(Date.now() - RANGES[timeRange].ms).toISOString());
        }

        const response = await apiFetch(`/api/emails?${queryParams.toString()}`);
        if (!response.ok) throw new Error(response.statusText);
        const data = await response.json();
        messages = data.emails || [];
        currentPage = data.currentPage || page;
        totalPages = data.totalPages || 1;
        const filtered = Boolean(searchInput || startDate || endDate || RANGES[timeRange]);
        $('messageInfo').textContent = `${data.totalEmails} ${filtered ? 'matching' : 'total'}`;
        if (!filtered) $('navCount').textContent = data.totalEmails || '';
    } catch (error) {
        messages = [];
        totalPages = 1;
        $('messageInfo').textContent = 'Could not load emails';
    }
    renderMessages();
    updatePagination();
}

async function reloadCurrentPage() {
    const { searchInput, startDate, endDate } = currentFilters();
    await loadMessages(currentPage, pageSize, searchInput, startDate, endDate);
}

const displayName = person => (person && (person.name || person.address)) || '';

// "alice@example.com", or "alice@example.com +2" when there are more recipients
function recipientSummary(email) {
    const recipients = email.to.length ? email.to.map(r => r.address) : email.envelope.to;
    if (recipients.length === 0) return '';
    return recipients.length > 1 ? `${recipients[0]} +${recipients.length - 1}` : recipients[0];
}

function renderMessages() {
    const list = $('messageList');
    list.replaceChildren();
    $('selectAllCheckbox').checked = false;
    updateSelectionInfo();

    if (messages.length === 0) {
        const filtered = Object.values(currentFilters()).some(Boolean) || Boolean(RANGES[timeRange]);
        list.appendChild(el('li', 'empty-state', filtered ? 'No emails match these filters.' : 'No emails yet. Send one to this server over SMTP, or use Send test.'));
        showDetails(null);
        return;
    }

    if (!messages.some(m => m.id === selectedId)) selectedId = messages[0].id;

    for (const msg of messages) {
        const li = el('li', 'message-row');
        li.dataset.id = String(msg.id);
        if (msg.id === selectedId) li.classList.add('selected');
        li.addEventListener('click', event => {
            if (event.target.closest('.row-check')) return;
            selectMessage(msg.id);
        });

        const check = el('input', 'message-checkbox');
        check.type = 'checkbox';
        check.dataset.id = String(msg.id);
        check.setAttribute('aria-label', `Select email ${msg.id}`);
        check.addEventListener('change', updateSelectionInfo);
        const checkWrap = el('label', 'row-check admin-only');
        checkWrap.appendChild(check);

        const top = el('div', 'row-top');
        top.appendChild(el('span', 'row-sender', displayName(msg.from) || 'Unknown sender'));
        top.appendChild(el('span', 'row-recipient mono', recipientSummary(msg) ? `to ${recipientSummary(msg)}` : ''));
        top.appendChild(el('span', 'spacer'));
        if (msg.attachmentCount) {
            const clip = el('span', 'row-attach');
            clip.title = `${msg.attachmentCount} attachment${msg.attachmentCount === 1 ? '' : 's'}`;
            clip.appendChild(svgIcon('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'));
            top.appendChild(clip);
        }
        const time = el('time', 'row-time', msg.timestamp ? formatMessageTime(msg.timestamp) : '');
        if (msg.timestamp) time.title = new Date(msg.timestamp).toLocaleString();
        top.appendChild(time);

        const body = el('div', 'row-body');
        body.appendChild(top);
        body.appendChild(el('div', 'row-subject', msg.subject || '(no subject)'));
        body.appendChild(el('div', 'row-text', msg.snippet));

        li.appendChild(checkWrap);
        li.appendChild(body);
        list.appendChild(li);
    }
    showDetails(messages.find(m => m.id === selectedId));
}

function selectMessage(id) {
    selectedId = id;
    document.querySelectorAll('.message-row').forEach(row => row.classList.toggle('selected', row.dataset.id === String(id)));
    showDetails(messages.find(m => m.id === id));
}

// Full emails (bodies, headers, attachments) are fetched when selected. They never change once stored,
// so each is kept for the rest of the page's life.
const fullEmails = new Map();

async function fetchFullEmail(id) {
    if (fullEmails.has(id)) return fullEmails.get(id);
    const response = await apiFetch(`/api/emails/${id}`);
    if (!response.ok) throw new Error(response.statusText);
    const email = await response.json();
    fullEmails.set(id, email);
    return email;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const formatAddress = person => (person.name ? `${person.name} <${person.address}>` : person.address);

// The header block: who sent it, to whom, when
function renderMeta(email) {
    const rows = [['From', formatAddress(email.from)]];
    if (email.to.length) rows.push(['To', email.to.map(formatAddress).join(', ')]);
    if (email.cc.length) rows.push(['Cc', email.cc.map(formatAddress).join(', ')]);
    // Recipients the mail was delivered to that aren't in the headers (Bcc, lists)
    const listed = new Set([...email.to, ...email.cc].map(r => r.address.toLowerCase()));
    const hidden = email.envelope.to.filter(address => !listed.has(address.toLowerCase()));
    if (hidden.length) rows.push(['Also to', hidden.join(', ')]);
    rows.push(['Received', email.timestamp ? new Date(email.timestamp).toLocaleString() : '']);
    rows.push(['Size', formatBytes(email.size)]);

    const meta = $('selectedMessageMeta');
    meta.replaceChildren();
    for (const [label, value] of rows) {
        meta.appendChild(el('dt', null, label));
        meta.appendChild(el('dd', label === 'Received' || label === 'Size' ? null : 'mono', value));
    }
}

// The email currently shown in the detail pane. Reloading the list (refresh, window focus) re-selects the
// same email; leaving the pane alone then keeps the preview from reloading and the chosen tab from resetting.
let shownEmailId = null;

function showDetails(summary) {
    $('detailEmpty').classList.toggle('hidden', Boolean(summary));
    $('detailBody').classList.toggle('hidden', !summary);
    if (!summary) {
        shownEmailId = null;
        return;
    }
    if (summary.id === shownEmailId) return;
    shownEmailId = summary.id;

    $('selectedMessageTitle').textContent = summary.subject || '(no subject)';
    $('selectedMessageKey').textContent = summary.smtpUser ? `via ${summary.smtpUser}` : '';
    $('selectedMessageKey').classList.toggle('hidden', !summary.smtpUser);
    renderMeta(summary);
    $('downloadEmlLink').href = `/api/emails/${summary.id}/raw?download=true`;
    $('copyCodeButton').classList.add('hidden');
    $('viewSwitch').replaceChildren();
    $('selectedMessageText').replaceChildren(el('div', 'muted', 'Loading…'));
    $('selectedMessageText').dataset.view = 'loading';

    const id = summary.id;
    fetchFullEmail(id)
        .then(email => {
            if (id === selectedId) renderEmailBody(email);
        })
        .catch(() => {
            if (id === selectedId) $('selectedMessageText').replaceChildren(el('div', 'muted', 'Could not load this email.'));
        });
}

// The tabs available for an email, in display order
function emailViews(email) {
    const views = [];
    if (email.html) views.push(['html', 'HTML']);
    views.push(['text', 'Text']);
    if (email.links.length) views.push(['links', `Links (${email.links.length})`]);
    views.push(['headers', 'Headers']);
    if (email.attachments.length) views.push(['attachments', `Attachments (${email.attachments.length})`]);
    views.push(['raw', 'Raw']);
    return views;
}

function renderEmailBody(email, view) {
    const views = emailViews(email);
    const preferred = view || readSetting('mail_view', '');
    const chosen = views.some(([name]) => name === preferred) ? preferred : views[0][0];

    // The detected one-time code, if any (see src/utils/otp.js)
    $('copyCodeButton').classList.toggle('hidden', !email.code);
    $('copyCodeButton').textContent = email.code ? `Copy code ${email.code}` : 'Copy code';
    $('copyCodeButton').dataset.code = email.code || '';
    $('copyMessageButton').classList.toggle('hidden', !email.text);

    const switcher = $('viewSwitch');
    switcher.replaceChildren();
    for (const [name, label] of views) {
        const button = el('button', name === chosen ? 'active' : '', label);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(name === chosen));
        button.addEventListener('click', () => {
            saveSetting('mail_view', name);
            renderEmailBody(email, name);
        });
        switcher.appendChild(button);
    }

    const body = $('selectedMessageText');
    body.dataset.view = chosen;
    body.replaceChildren();
    if (chosen === 'html') {
        // The page is sandboxed by the server's Content-Security-Policy header (no scripts, no network,
        // opaque origin; see getPreview), so no sandbox attribute is needed here
        const frame = el('iframe', 'email-frame');
        frame.title = 'Email preview';
        frame.src = `/api/emails/${email.id}/preview`;
        body.appendChild(frame);
        body.appendChild(el('div', 'frame-note', 'Scripts and remote images are blocked.'));
    } else if (chosen === 'text') {
        body.appendChild(el('pre', 'formatted-code', email.text || '(no text part)'));
    } else if (chosen === 'links') {
        body.appendChild(linkList(email.links));
    } else if (chosen === 'headers') {
        body.appendChild(headerTable(email.headers));
    } else if (chosen === 'attachments') {
        body.appendChild(attachmentList(email.attachments));
    } else {
        renderRaw(body, email.id);
    }
}

function linkList(links) {
    const list = el('ul', 'link-list');
    for (const url of links) {
        const item = el('li');
        const anchor = el('a', null, url);
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        const copy = el('button', 'ghost small', 'Copy');
        copy.type = 'button';
        copy.addEventListener('click', () => copyText(url, copy));
        item.append(anchor, copy);
        list.appendChild(item);
    }
    return list;
}

function headerTable(headers) {
    const table = el('table', 'ref-table header-table');
    for (const { key, value } of headers) {
        const row = el('tr');
        row.append(el('th', null, key), el('td', 'mono', value));
        table.appendChild(row);
    }
    return table;
}

function attachmentList(attachments) {
    const list = el('ul', 'attachment-list');
    for (const attachment of attachments) {
        const item = el('li');
        const download = el('a', null, attachment.filename);
        download.href = attachment.url;
        download.download = attachment.filename;
        item.append(download, el('span', 'muted', `${attachment.contentType} · ${formatBytes(attachment.size)}`));
        list.appendChild(item);
    }
    return list;
}

const RAW_DISPLAY_LIMIT = 200000;

async function renderRaw(container, id) {
    container.appendChild(el('div', 'muted', 'Loading…'));
    try {
        const response = await apiFetch(`/api/emails/${id}/raw`);
        if (!response.ok) throw new Error(response.statusText);
        const text = await response.text();
        if (id !== selectedId || container.dataset.view !== 'raw') return;
        const shown = text.length > RAW_DISPLAY_LIMIT ? `${text.slice(0, RAW_DISPLAY_LIMIT)}\n\n… truncated; use Download .eml for the full message` : text;
        container.replaceChildren(el('pre', 'formatted-code', shown));
    } catch (error) {
        if (id === selectedId && container.dataset.view === 'raw') container.replaceChildren(el('div', 'muted', 'Could not load the raw message.'));
    }
}

// Up/down arrow keys move through the list
function moveSelection(step) {
    const idx = messages.findIndex(m => m.id === selectedId);
    const next = messages[idx + step];
    if (!next) return;
    selectMessage(next.id);
    const row = document.querySelector(`.message-row[data-id="${next.id}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
}

// --- Resizable message pane ---

const DEFAULT_DETAIL_RATIO = 0.42;
const MIN_DETAIL_PX = 300;
const MIN_LIST_PX = 360;

// The detail pane width is stored as a share of the layout, so it adapts when the window is resized
function applyDetailRatio(ratio) {
    const layout = document.querySelector('.messages-layout');
    const width = layout.getBoundingClientRect().width;
    if (!width) return;
    const px = Math.min(Math.max(ratio * width, MIN_DETAIL_PX), Math.max(MIN_DETAIL_PX, width - MIN_LIST_PX));
    layout.style.setProperty('--detail-width', `${Math.round(px)}px`);
    $('paneResizer').setAttribute('aria-valuenow', String(Math.round((px / width) * 100)));
}

function initPaneResizer() {
    const layout = document.querySelector('.messages-layout');
    const resizer = $('paneResizer');
    let ratio = parseFloat(readSetting('mail_detail_ratio', '')) || DEFAULT_DETAIL_RATIO;
    const apply = () => applyDetailRatio(ratio);
    const save = () => saveSetting('mail_detail_ratio', ratio.toFixed(3));
    resizer.setAttribute('aria-valuemin', '20');
    resizer.setAttribute('aria-valuemax', '75');

    resizer.addEventListener('pointerdown', event => {
        event.preventDefault();
        resizer.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing');
        const onMove = moveEvent => {
            const rect = layout.getBoundingClientRect();
            ratio = Math.min(Math.max((rect.right - moveEvent.clientX) / rect.width, 0.2), 0.75);
            apply();
        };
        const onUp = () => {
            resizer.removeEventListener('pointermove', onMove);
            resizer.removeEventListener('pointerup', onUp);
            resizer.removeEventListener('pointercancel', onUp);
            document.body.classList.remove('resizing');
            save();
        };
        resizer.addEventListener('pointermove', onMove);
        resizer.addEventListener('pointerup', onUp);
        resizer.addEventListener('pointercancel', onUp);
    });
    // Keyboard: arrow keys resize in 2% steps
    resizer.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        ratio = Math.min(Math.max(ratio + (event.key === 'ArrowLeft' ? 0.02 : -0.02), 0.2), 0.75);
        apply();
        save();
    });
    resizer.addEventListener('dblclick', () => {
        ratio = DEFAULT_DETAIL_RATIO;
        apply();
        save();
    });
    window.addEventListener('resize', apply);
    window.addEventListener('hashchange', () => requestAnimationFrame(apply));
    apply();
}

// --- Messages: pagination, filters, selection ---

function updatePagination() {
    $('prevPage').disabled = currentPage <= 1;
    $('nextPage').disabled = currentPage >= totalPages;
    $('pageInfo').textContent = `${currentPage} / ${totalPages}`;
}

async function changePage(direction) {
    currentPage = Math.min(Math.max(1, currentPage + direction), totalPages);
    await reloadCurrentPage();
}

async function changePageSize() {
    pageSize = parseInt($('pageSizeSelect').value, 10);
    currentPage = 1;
    await reloadCurrentPage();
}

async function filterMessages() {
    currentPage = 1;
    await reloadCurrentPage();
}

async function resetFilters() {
    $('searchInput').value = '';
    $('startDate').value = '';
    $('endDate').value = '';
    timeRange = 'all';
    renderRange();
    await filterMessages();
}

// Picking dates in the toolbar switches the sidebar range to "Custom dates"
async function onDateChange() {
    const hasDates = Boolean($('startDate').value || $('endDate').value);
    timeRange = hasDates ? 'custom' : 'all';
    renderRange();
    await filterMessages();
}

function reloadWithSavedParams() {
    try {
        const saved = JSON.parse(readSetting('mail_query_params', 'null'));
        if (saved) {
            $('searchInput').value = saved.searchInput || '';
            $('startDate').value = saved.startDate || '';
            $('endDate').value = saved.endDate || '';
            timeRange = RANGES[saved.timeRange] || saved.timeRange === 'custom' ? saved.timeRange : 'all';
            renderRange();
            if (saved.pageSize) {
                pageSize = saved.pageSize;
                $('pageSizeSelect').value = saved.pageSize;
            }
            loadMessages(saved.page || 1, pageSize, saved.searchInput || '', saved.startDate || '', saved.endDate || '');
            return;
        }
    } catch {
        // fall through: load all
    }
    loadMessages(1, pageSize);
}

function selectedIds() {
    return Array.from(document.querySelectorAll('.message-checkbox:checked')).map(c => Number(c.dataset.id));
}

function updateSelectionInfo() {
    const count = selectedIds().length;
    $('selectionInfo').textContent = count ? `${count} selected` : '';
    $('deleteSelectedButton').disabled = count === 0;
    $('selectAllCheckbox').checked = count > 0 && count === messages.length;
}

function toggleSelectAll(checked) {
    document.querySelectorAll('.message-checkbox').forEach(c => (c.checked = checked));
    updateSelectionInfo();
}

async function deleteSelectedMessages() {
    const ids = selectedIds();
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} email(s)? This can't be undone.`)) return;
    try {
        const response = await apiFetch('/api/emails', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        if (!response.ok) alert('Failed to delete the selected emails.');
        await reloadCurrentPage();
    } catch (error) {
        alert('An error occurred while deleting the emails.');
    }
}

// --- Send test ---

const MAX_BODY = 200000;
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const TEST_FIELDS = ['from', 'to', 'subject', 'text', 'html'];

// The server's SMTP address as seen from this page, filled in from /api/info
let smtpInfo = { smtpPort: 1025, smtpAuthRequired: false, smtpUsername: null };

async function loadServerInfo() {
    try {
        const response = await apiFetch('/api/info');
        if (response.ok) smtpInfo = await response.json();
    } catch {
        // keep the defaults
    }
    renderApiReference();
    updateEquivalentCommand();
}

function formValues() {
    return {
        from: $('fromInput').value.trim(),
        to: $('toInput').value.trim(),
        subject: $('subjectInput').value.trim(),
        text: $('textInput').value,
        html: $('htmlInput').value,
    };
}

function updateBodyCounter() {
    const length = $('textInput').value.length + $('htmlInput').value.length;
    $('bodyCounter').textContent = length ? `${length.toLocaleString()} characters` : '';
}

// Shows the swaks command that would deliver the same email over SMTP from outside the dashboard
function updateEquivalentCommand() {
    const { from, to, subject, text } = formValues();
    const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const lines = [
        `swaks --server ${location.hostname}:${smtpInfo.smtpPort} \\`,
        `  --from ${quote(from || 'noreply@example.com')} \\`,
        `  --to ${quote(to || 'user@example.com')} \\`,
        `  --header ${quote(`Subject: ${subject || 'Test email'}`)} \\`,
        `  --body ${quote(text || 'Your verification code is 123456')}`,
    ];
    if (smtpInfo.smtpAuthRequired) lines.splice(1, 0, `  --auth-user ${quote(smtpInfo.smtpUsername || 'USERNAME')} --auth-password "$SMTP_PASSWORD" \\`);
    $('equivalentCommand').textContent = lines.join('\n');
}

function setFieldError(field, message) {
    $(`${field}Error`).textContent = message || '';
    $(`${field}Input`).classList.toggle('invalid', Boolean(message));
}

function clearFieldErrors() {
    TEST_FIELDS.forEach(field => setFieldError(field, ''));
}

// Same rules as the server, so most mistakes are caught before sending
function validateForm({ from, to, subject, text, html }) {
    const errors = {};
    if (!EMAIL_RE.test(from)) errors.from = 'Enter an email address.';
    const recipients = to.split(/[,;\s]+/).filter(Boolean);
    if (recipients.length === 0 || recipients.length > 20 || !recipients.every(a => EMAIL_RE.test(a))) {
        errors.to = 'Enter 1–20 email addresses separated by commas.';
    }
    if (subject.length > 255) errors.subject = 'At most 255 characters.';
    if (!text.trim() && !html.trim()) errors.text = 'Enter a text or an HTML body.';
    if (text.length > MAX_BODY) errors.text = `At most ${MAX_BODY.toLocaleString()} characters.`;
    if (html.length > MAX_BODY) errors.html = `At most ${MAX_BODY.toLocaleString()} characters.`;
    return errors;
}

function setFormStatus(text, kind) {
    $('formStatus').textContent = text;
    $('formStatus').className = `form-status${kind ? ` ${kind}` : ''}`;
}

function fillSampleEmail() {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!$('fromInput').value) $('fromInput').value = 'noreply@example.com';
    if (!$('toInput').value) $('toInput').value = 'user@example.com';
    $('subjectInput').value = 'Verify your email address';
    $('textInput').value = `Your verification code is ${code}.\n\nOr confirm directly: https://app.example.com/verify?token=${code}\n\nThis code expires in 10 minutes.`;
    $('htmlInput').value = `<div style="font-family:sans-serif"><h2>Verify your email</h2><p>Your verification code is <b style="font-size:20px">${code}</b>.</p><p><a href="https://app.example.com/verify?token=${code}">Confirm my email</a></p><p style="color:#888">This code expires in 10 minutes.</p></div>`;
    clearFieldErrors();
    onFormInput();
}

function onFormInput() {
    updateBodyCounter();
    updateEquivalentCommand();
}

function clearForm() {
    $('messageForm').reset();
    clearFieldErrors();
    setFormStatus('');
    onFormInput();
}

async function sendMessage(event) {
    event.preventDefault();
    const values = formValues();
    clearFieldErrors();
    const errors = validateForm(values);
    if (Object.keys(errors).length) {
        Object.entries(errors).forEach(([field, msg]) => setFieldError(field, msg));
        setFormStatus('Fix the highlighted fields.', 'error');
        return;
    }

    const button = $('sendButton');
    button.disabled = true;
    setFormStatus('Sending…');
    try {
        const response = await apiFetch('/api/emails/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(values),
        });
        const data = await response.json().catch(() => ({}));
        $('lastResponse').textContent = `HTTP ${response.status}\n${JSON.stringify(data, null, 2)}`;
        $('lastResponse').classList.remove('muted-code');

        if (response.ok) {
            setFormStatus(`Stored as email #${data.id}.`, 'success');
            $('viewInMessages').classList.remove('hidden');
            selectedId = data.id;
            currentPage = 1;
            // Keep the addresses so several emails can be sent in a row
            $('subjectInput').value = '';
            $('textInput').value = '';
            $('htmlInput').value = '';
            onFormInput();
            $('subjectInput').focus();
        } else if (data.details) {
            // Server messages read like "must be ..." / "is required"; prefix the field name
            Object.entries(data.details).forEach(([field, msg]) => {
                if (!TEST_FIELDS.includes(field)) return;
                const label = field.charAt(0).toUpperCase() + field.slice(1);
                setFieldError(field, `${label} ${msg}.`);
            });
            setFormStatus('The server rejected the email. See the highlighted fields.', 'error');
        } else {
            setFormStatus(`Failed to send: ${data.error || response.statusText}`, 'error');
        }
    } catch (error) {
        setFormStatus('Could not reach the server.', 'error');
    } finally {
        button.disabled = false;
    }
}

// --- API keys ---

// Full keys revealed on this page, by key id. Only kept while the page is open, and cleared when
// navigating to another view.
const revealedKeys = new Map();
let keysData = { keys: [], adminTokenConfigured: false };

function forgetRevealedKeys() {
    revealedKeys.clear();
    $('newKeyResult').classList.add('hidden');
    $('newKeySecret').textContent = '';
    $('newKeyExample').textContent = '';
}

async function apiJson(url, options = {}) {
    const headers = options.body ? { 'Content-Type': 'application/json' } : {};
    const response = await apiFetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    return { response, data };
}

async function loadKeys() {
    try {
        const { response, data } = await apiJson('/api/keys');
        if (!response.ok) throw new Error(data.error || response.statusText);
        keysData = data;
    } catch (error) {
        keysData = { keys: [], adminTokenConfigured: false };
        $('keysFootnote').textContent = `Could not load API keys: ${error.message}`;
    }
    renderKeys();
}

function keyExample(secret) {
    return [
        `curl -H "Authorization: Bearer ${secret}" \\`,
        `  "${location.origin}/api/emails/latest?to=user%40example.com"`,
    ].join('\n');
}

// Fetches (once) and returns a key's full value
async function revealKey(rowId, url) {
    if (revealedKeys.has(rowId)) return revealedKeys.get(rowId);
    const { response, data } = await apiJson(url, { method: 'POST' });
    if (!response.ok) throw new Error(data.error || response.statusText);
    revealedKeys.set(rowId, data.secret);
    return data.secret;
}

// An inline SVG icon from fixed markup in this file (never from message or key data)
function svgIcon(innerMarkup) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = innerMarkup;
    return svg;
}

function keyRow({ id, name, scope, prefix, lastUsedAt, createdAt, revokedAt }) {
    const rowId = id;
    const revealUrl = `/api/keys/${id}/reveal`;
    const tr = el('tr', revokedAt ? 'key-revoked' : '');

    const nameCell = el('td', 'key-name');
    nameCell.appendChild(el('span', null, name));
    tr.appendChild(nameCell);

    const typeCell = el('td');
    typeCell.appendChild(el('span', `scope-badge scope-${scope}`, scope === 'read' ? 'Read' : scope));
    tr.appendChild(typeCell);

    const keyCell = el('td', 'key-value');
    const shown = revealedKeys.get(rowId);
    keyCell.appendChild(el('code', null, shown || `${prefix}…`));
    if (!revokedAt) {
        const actions = el('span', 'key-actions');
        const toggle = el('button', 'ghost small', shown ? 'Hide' : 'Show');
        toggle.type = 'button';
        toggle.addEventListener('click', async () => {
            if (revealedKeys.has(rowId)) {
                revealedKeys.delete(rowId);
                return renderKeys();
            }
            try {
                await revealKey(rowId, revealUrl);
                renderKeys();
            } catch (error) {
                alert(error.message);
            }
        });
        const copy = el('button', 'ghost small', 'Copy');
        copy.type = 'button';
        copy.addEventListener('click', async () => {
            try {
                copyText(await revealKey(rowId, revealUrl), copy);
            } catch (error) {
                alert(error.message);
            }
        });
        actions.append(toggle, copy);
        keyCell.appendChild(actions);
    }
    tr.appendChild(keyCell);

    tr.appendChild(el('td', 'muted', lastUsedAt ? formatMessageTime(lastUsedAt) : 'Never'));
    tr.appendChild(el('td', 'muted', new Date(createdAt).toLocaleDateString()));

    const actionCell = el('td', 'key-row-action');
    if (revokedAt) {
        const revoked = el('span', 'revoked-tag', 'Revoked');
        revoked.tabIndex = 0;
        revoked.dataset.tooltip = `Revoked ${new Date(revokedAt).toLocaleString()}`;
        actionCell.appendChild(revoked);
    } else {
        // Icon button; "Revoke key" appears as a tooltip on hover or keyboard focus
        const revoke = el('button', 'icon-action danger-icon');
        revoke.type = 'button';
        revoke.dataset.tooltip = 'Revoke key';
        revoke.setAttribute('aria-label', `Revoke key "${name}"`);
        revoke.appendChild(svgIcon('<circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/>'));
        revoke.addEventListener('click', () => revokeKey(id, name));
        actionCell.appendChild(revoke);
    }
    tr.appendChild(actionCell);
    return tr;
}

function renderKeys() {
    const body = $('keysBody');
    body.replaceChildren();
    const rows = keysData.keys; // active first, then revoked (sorted by the server)
    rows.forEach(row => body.appendChild(keyRow(row)));
    $('keysEmpty').classList.toggle('hidden', rows.length > 0);
    document.querySelector('.keys-table').classList.toggle('hidden', rows.length === 0);
    $('keysFootnote').textContent = keysData.adminTokenConfigured
        ? 'ADMIN_TOKEN from .env also gives full API access (including deleting messages). It is not shown here.'
        : '';
}

function showKeyForm(visible) {
    $('newKeyForm').classList.toggle('hidden', !visible);
    $('newKeyButton').classList.toggle('hidden', visible);
    $('keyNameError').textContent = '';
    $('keyNameInput').classList.remove('invalid');
    if (visible) {
        $('newKeyResult').classList.add('hidden');
        $('keyNameInput').focus();
    } else {
        $('newKeyForm').reset();
    }
}

async function createKey(event) {
    event.preventDefault();
    const name = $('keyNameInput').value.trim();
    if (!name) {
        $('keyNameError').textContent = 'Give the key a name, e.g. the app that will use it.';
        $('keyNameInput').classList.add('invalid');
        return;
    }
    $('createKeyButton').disabled = true;
    try {
        const { response, data } = await apiJson('/api/keys', { method: 'POST', body: JSON.stringify({ name }) });
        if (!response.ok) {
            const message = data.details ? Object.entries(data.details).map(([field, msg]) => `Name ${msg}.`).join(' ') : data.error;
            $('keyNameError').textContent = message || 'Could not create the key.';
            $('keyNameInput').classList.add('invalid');
            return;
        }
        revealedKeys.set(data.key.id, data.secret);
        showKeyForm(false);
        $('newKeyName').textContent = data.key.name;
        $('newKeySecret').textContent = data.secret;
        $('newKeyExample').textContent = keyExample(data.secret);
        $('newKeyResult').classList.remove('hidden');
        await loadKeys();
    } catch (error) {
        $('keyNameError').textContent = 'Could not reach the server.';
    } finally {
        $('createKeyButton').disabled = false;
    }
}

async function revokeKey(id, name) {
    if (!confirm(`Revoke "${name}"?\n\nAnything using this key stops working immediately. This can't be undone.`)) return;
    const { response, data } = await apiJson(`/api/keys/${id}`, { method: 'DELETE' });
    if (!response.ok) alert(data.error || 'Could not revoke the key.');
    revealedKeys.delete(id);
    await loadKeys();
}

// --- API reference ---

function renderApiReference() {
    const base = location.origin;
    const host = location.hostname;
    const port = smtpInfo.smtpPort;
    $('smtpAddress').textContent = `${host}:${port}`;
    $('smtpAuthNote').textContent = smtpInfo.smtpAuthRequired
        ? `Login required${smtpInfo.smtpUsername ? ` (user "${smtpInfo.smtpUsername}", password from SMTP_PASSWORD in .env)` : ''}`
        : 'No login needed (any credentials are accepted)';
    $('nodemailerExample').textContent = [
        "const nodemailer = require('nodemailer');",
        '',
        'const transport = nodemailer.createTransport({',
        `  host: '${host}',`,
        `  port: ${port},`,
        '  secure: false,',
        '  ignoreTLS: true,',
        ...(smtpInfo.smtpAuthRequired ? ["  auth: { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD },"] : []),
        '});',
        "await transport.sendMail({ from: 'noreply@example.com', to: 'user@example.com', subject: 'Hello', text: 'Your code is 123456' });",
    ].join('\n');
    $('envExample').textContent = [
        `SMTP_HOST=${host}`,
        `SMTP_PORT=${port}`,
        'SMTP_SECURE=false   # plain SMTP, no TLS',
    ].join('\n');
    $('curlLatest').textContent = [
        'curl -H "Authorization: Bearer $API_KEY" \\',
        `  "${base}/api/emails/latest?to=user%40example.com"`,
    ].join('\n');
    $('jsLatest').textContent = [
        `const res = await fetch('${base}/api/emails/latest?to=user%40example.com', {`,
        '  headers: { Authorization: `Bearer ${process.env.API_KEY}` },',
        '});',
        'const { subject, code, links, text, html } = await res.json();',
        '// code: the detected one-time code, or null; links: every http(s) link in the email',
    ].join('\n');
}

// --- Wiring ---

window.addEventListener('DOMContentLoaded', () => {
    setSidebarCollapsed(readSetting('mail_sidebar_collapsed', 'no') === 'yes');
    renderApiReference();
    onFormInput();
    loadServerInfo();

    $('collapseButton').addEventListener('click', () => setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed')));
    $('logoutButton').addEventListener('click', logout);

    // Messages
    $('searchButton').addEventListener('click', filterMessages);
    $('searchInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') filterMessages();
    });
    $('startDate').addEventListener('change', onDateChange);
    $('endDate').addEventListener('change', onDateChange);
    $('rangeSelect').addEventListener('change', event => setTimeRange(event.target.value));
    $('rangeChip').addEventListener('click', () => setTimeRange('all'));
    initPaneResizer();
    initSidebarResizer();
    $('resetFiltersButton').addEventListener('click', resetFilters);
    $('refreshButton').addEventListener('click', reloadCurrentPage);
    $('prevPage').addEventListener('click', () => changePage(-1));
    $('nextPage').addEventListener('click', () => changePage(1));
    $('pageSizeSelect').addEventListener('change', changePageSize);
    $('selectAllCheckbox').addEventListener('change', event => toggleSelectAll(event.target.checked));
    $('deleteSelectedButton').addEventListener('click', deleteSelectedMessages);
    // Copies the plain-text body, whatever view is showing
    $('copyMessageButton').addEventListener('click', event => {
        const email = fullEmails.get(selectedId);
        if (email) copyText(email.text || '', event.target);
    });
    $('copyCodeButton').addEventListener('click', event => copyText(event.target.dataset.code, event.target));
    document.addEventListener('keydown', event => {
        if (currentView() !== 'messages' || event.target.matches('input, textarea, select')) return;
        if (event.key === 'ArrowDown' || event.key === 'j') {
            event.preventDefault();
            moveSelection(1);
        } else if (event.key === 'ArrowUp' || event.key === 'k') {
            event.preventDefault();
            moveSelection(-1);
        }
    });

    // Send test
    $('messageForm').addEventListener('submit', sendMessage);
    $('clearFormButton').addEventListener('click', clearForm);
    $('sampleEmailButton').addEventListener('click', fillSampleEmail);
    TEST_FIELDS.forEach(field =>
        $(`${field}Input`).addEventListener('input', () => {
            setFieldError(field, '');
            onFormInput();
        })
    );

    // API keys
    $('newKeyButton').addEventListener('click', () => showKeyForm(true));
    $('cancelKeyButton').addEventListener('click', () => showKeyForm(false));
    $('newKeyForm').addEventListener('submit', createKey);
    $('keyNameInput').addEventListener('input', () => {
        $('keyNameError').textContent = '';
        $('keyNameInput').classList.remove('invalid');
    });
    $('copyNewKey').addEventListener('click', event => copyText($('newKeySecret').textContent, event.target));
    $('dismissKeyResult').addEventListener('click', () => $('newKeyResult').classList.add('hidden'));

    // API reference
    document.querySelectorAll('.copy-button').forEach(button =>
        button.addEventListener('click', () => copyText($(button.dataset.copy).textContent, button))
    );

    // Refresh the list when the tab regains focus
    window.addEventListener('focus', () => {
        if (currentView() === 'messages') reloadCurrentPage();
    });

    window.addEventListener('hashchange', showView);
    // Know the role before showing a view, so a viewer never lands on an admin-only page
    loadSession().then(showView);
});
