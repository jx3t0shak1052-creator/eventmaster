'use strict';

/**
 * 飲み会管理アプリ - フロントエンド（依存なし・バニラJS）
 */

const state = {
  events: [],
  selectedId: null,
  search: '',
  editingEventId: null,
};

const el = (id) => document.getElementById(id);
const yen = (n) => '\u00a5' + Number(n || 0).toLocaleString('ja-JP');

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    const detail = data && data.details ? '：' + data.details.join(' / ') : '';
    throw new Error((data && data.error ? data.error : '通信エラー') + detail);
  }
  return data;
}

function toast(message, isError) {
  const t = el('toast');
  t.textContent = message;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

function fmtDate(ev) {
  if (!ev.date) return '日時未定';
  return ev.time ? ev.date + ' ' + ev.time : ev.date;
}

function renderEventList() {
  const list = el('event-list');
  if (!state.events.length) {
    list.innerHTML = '<li class="empty">飲み会がありません。「＋ 新しい飲み会」から追加してください。</li>';
    return;
  }
  list.innerHTML = state.events.map((ev) => `
    <li class="event-item ${ev.id === state.selectedId ? 'active' : ''}" data-id="${ev.id}" tabindex="0">
      <div class="event-title">${escapeHtml(ev.name)}</div>
      <div class="event-meta">${escapeHtml(fmtDate(ev))}${ev.venue ? ' ・ ' + escapeHtml(ev.venue) : ''}</div>
      <div class="event-badges">
        <span class="badge">👥 ${ev.stats.participants}</span>
        <span class="badge paid">支払 ${ev.stats.paid}</span>
        <span class="badge unpaid">未 ${ev.stats.unpaid}</span>
        <span class="badge money">${yen(ev.stats.collected)}/${yen(ev.stats.expected)}</span>
      </div>
    </li>`).join('');

  list.querySelectorAll('.event-item').forEach((li) => {
    const id = Number(li.dataset.id);
    li.addEventListener('click', () => selectEvent(id));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectEvent(id); });
  });
}

function renderDetail() {
  const detail = el('detail');
  const ev = state.events.find((e) => e.id === state.selectedId);
  if (!ev) {
    detail.innerHTML = '<div class="placeholder">左の一覧から飲み会を選ぶか、新しい飲み会を追加してください。</div>';
    return;
  }
  const pct = ev.stats.expected > 0
    ? Math.round((ev.stats.collected / ev.stats.expected) * 100)
    : (ev.stats.paid > 0 ? 100 : 0);
  const participants = ev.participants || [];

  detail.innerHTML = `
    <header class="detail-head">
      <div>
        <h2>${escapeHtml(ev.name)}</h2>
        <div class="detail-sub">📅 ${escapeHtml(fmtDate(ev))}</div>
        <div class="detail-sub">📍 ${ev.venue ? escapeHtml(ev.venue) : '場所未定'}</div>
        <div class="detail-sub">💰 参加費 ${yen(ev.fee)} / 人</div>
        ${ev.note ? `<div class="detail-note">${escapeHtml(ev.note)}</div>` : ''}
      </div>
      <div class="detail-actions">
        <button class="btn ghost" id="edit-event">編集</button>
        <button class="btn ghost danger" id="delete-event">削除</button>
      </div>
    </header>

    <section class="stats">
      <div class="stat"><span class="stat-num">${ev.stats.participants}</span><span class="stat-label">参加者</span></div>
      <div class="stat paid"><span class="stat-num">${ev.stats.paid}</span><span class="stat-label">支払済</span></div>
      <div class="stat unpaid"><span class="stat-num">${ev.stats.unpaid}</span><span class="stat-label">未払い</span></div>
      <div class="stat"><span class="stat-num">${yen(ev.stats.collected)}</span><span class="stat-label">集金済み</span></div>
      <div class="stat"><span class="stat-num">${yen(ev.stats.expected)}</span><span class="stat-label">予定額</span></div>
    </section>

    <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
    <div class="progress-label">集金率 ${pct}%</div>

    <section class="participants">
      <div class="section-head">
        <h3>参加者名簿</h3>
        <div class="bulk">
          <button class="btn small ghost" id="mark-all-paid">全員支払済</button>
          <button class="btn small ghost" id="mark-all-unpaid">全員未払い</button>
        </div>
      </div>

      <form id="add-participant" class="inline-form" autocomplete="off">
        <input name="name" placeholder="参加者名" required maxlength="80" />
        <input name="group" placeholder="区分（任意: 幹事/OB等）" maxlength="60" />
        <input name="fee" type="number" min="0" step="100" placeholder="参加費（未入力=既定 ${ev.fee}円）" />
        <button class="btn small" type="submit">＋ 追加</button>
      </form>

      ${participants.length ? `
      <table class="ptable">
        <thead><tr><th>名前</th><th>区分</th><th>参加費</th><th>支払い</th><th>メモ</th><th></th></tr></thead>
        <tbody>
        ${participants.map((p) => `
          <tr class="prow ${p.paid ? 'is-paid' : ''}">
            <td class="pname">${escapeHtml(p.name)}</td>
            <td>${p.group ? escapeHtml(p.group) : '<span class="muted">—</span>'}</td>
            <td>
              <input class="fee-input" type="number" min="0" step="100" data-fee="${p.id}" value="${p.fee !== null && p.fee !== undefined ? p.fee : ''}" placeholder="${ev.fee}" title="未入力の場合は飲み会の既定参加費 ${ev.fee}円 が適用されます" />
              <span class="fee-applied">適用 ${yen(p.amount)}</span>
            </td>
            <td>
              <label class="toggle">
                <input type="checkbox" data-toggle-paid="${p.id}" ${p.paid ? 'checked' : ''} />
                <span>${p.paid ? '支払済' : '未払い'}</span>
              </label>
            </td>
            <td><input class="memo-input" data-memo="${p.id}" value="${escapeHtml(p.memo || '')}" placeholder="メモ" maxlength="300" /></td>
            <td><button class="btn tiny ghost danger" data-del-participant="${p.id}">削除</button></td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty">参加者がまだ登録されていません。</div>'}
    </section>
    <section class="export-row">
      <a class="btn ghost small" href="/api/export" download>全体データをエクスポート(JSON)</a>
    </section>
  `;

  el('edit-event').addEventListener('click', () => openEventDialog(ev));
  el('delete-event').addEventListener('click', () => deleteEvent(ev));
  el('mark-all-paid').addEventListener('click', () => bulkPaid(ev.id, true));
  el('mark-all-unpaid').addEventListener('click', () => bulkPaid(ev.id, false));
  el('add-participant').addEventListener('submit', (e) => addParticipant(e, ev.id));

  detail.querySelectorAll('[data-toggle-paid]').forEach((cb) => {
    cb.addEventListener('change', (e) => togglePaid(Number(e.target.dataset.togglePaid), e.target.checked));
  });
  detail.querySelectorAll('[data-del-participant]').forEach((btn) => {
    btn.addEventListener('click', (e) => deleteParticipant(Number(e.target.dataset.delParticipant)));
  });
  detail.querySelectorAll('[data-memo]').forEach((inp) => {
    inp.addEventListener('change', (e) => updateMemo(Number(e.target.dataset.memo), e.target.value));
  });
  detail.querySelectorAll('[data-fee]').forEach((inp) => {
    inp.addEventListener('change', (e) => updateFee(Number(e.target.dataset.fee), e.target.value));
  });
}

function render() {
  renderEventList();
  renderDetail();
}

async function loadEvents() {
  const data = await api('/api/events' + (state.search ? '?q=' + encodeURIComponent(state.search) : ''));
  state.events = data.events;
  if (state.selectedId && !state.events.find((e) => e.id === state.selectedId)) {
    state.selectedId = null;
  }
  if (!state.selectedId && state.events.length) state.selectedId = state.events[0].id;
  render();
}

function selectEvent(id) {
  state.selectedId = id;
  render();
}

async function addParticipant(e, eventId) {
  e.preventDefault();
  const form = e.target;
  const name = form.name.value.trim();
  const group = form.group.value.trim();
  const feeRaw = form.fee.value;
  if (!name) return;
  const body = { name, group };
  // 参加費が入力されていれば個別設定として送る（未入力なら既定参加費を使用）
  if (feeRaw !== '') body.fee = Number(feeRaw);
  try {
    await api(`/api/events/${eventId}/participants`, { method: 'POST', body });
    toast('参加者を追加しました');
    await loadEvents();
  } catch (err) { toast(err.message, true); }
}

async function togglePaid(id, paid) {
  try {
    await api(`/api/participants/${id}`, { method: 'PUT', body: { paid } });
    await loadEvents();
  } catch (err) { toast(err.message, true); }
}

async function updateFee(id, rawValue) {
  // 入力が空なら個別参加費を解除（null = イベント既定を使用）
  const body = { fee: rawValue === '' ? null : Number(rawValue) };
  if (body.fee !== null && (!Number.isFinite(body.fee) || body.fee < 0)) {
    toast('参加費は0以上の数値を入力してください', true);
    return;
  }
  try {
    await api(`/api/participants/${id}`, { method: 'PUT', body });
    toast('参加費を更新しました');
    await loadEvents();
  } catch (err) { toast(err.message, true); }
}

async function updateMemo(id, memo) {
  try {
    await api(`/api/participants/${id}`, { method: 'PUT', body: { memo } });
    toast('メモを保存しました');
  } catch (err) { toast(err.message, true); }
}

async function deleteParticipant(id) {
  if (!confirm('この参加者を削除しますか？')) return;
  try {
    await api(`/api/participants/${id}`, { method: 'DELETE' });
    toast('削除しました');
    await loadEvents();
  } catch (err) { toast(err.message, true); }
}

async function bulkPaid(eventId, paid) {
  const ev = state.events.find((e) => e.id === eventId);
  if (!ev || !ev.participants.length) return;
  if (!confirm(paid ? '全員を「支払済」にしますか？' : '全員を「未払い」にしますか？')) return;
  try {
    for (const p of ev.participants) {
      if (p.paid !== paid) await api(`/api/participants/${p.id}`, { method: 'PUT', body: { paid } });
    }
    toast('更新しました');
    await loadEvents();
  } catch (err) { toast(err.message, true); }
}

async function deleteEvent(ev) {
  if (!confirm(`「${ev.name}」を削除しますか？参加者情報も削除されます。`)) return;
  try {
    await api(`/api/events/${ev.id}`, { method: 'DELETE' });
    state.selectedId = null;
    toast('飲み会を削除しました');
    await loadEvents();
  } catch (err) { toast(err.message, true); }
}

function openEventDialog(ev) {
  state.editingEventId = ev ? ev.id : null;
  el('dialog-title').textContent = ev ? '飲み会を編集' : '新しい飲み会';
  const f = el('event-form');
  f.reset();
  if (ev) {
    f.name.value = ev.name || '';
    f.date.value = ev.date || '';
    f.time.value = ev.time || '';
    f.venue.value = ev.venue || '';
    f.fee.value = ev.fee || 0;
    f.note.value = ev.note || '';
  } else {
    const d = new Date();
    f.date.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  el('dialog-backdrop').classList.add('show');
  setTimeout(() => f.name.focus(), 50);
}

function closeEventDialog() {
  el('dialog-backdrop').classList.remove('show');
  state.editingEventId = null;
}

async function submitEventForm(e) {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value.trim(),
    date: f.date.value,
    time: f.time.value,
    venue: f.venue.value.trim(),
    fee: f.fee.value === '' ? 0 : Number(f.fee.value),
    note: f.note.value.trim(),
  };
  if (!body.name) { toast('飲み会名を入力してください', true); return; }
  try {
    if (state.editingEventId) {
      await api(`/api/events/${state.editingEventId}`, { method: 'PUT', body });
      toast('更新しました');
      state.selectedId = state.editingEventId;
    } else {
      const data = await api('/api/events', { method: 'POST', body });
      toast('作成しました');
      state.selectedId = data.event.id;
    }
    closeEventDialog();
    await loadEvents();
  } catch (err) { toast(err.message, true); }
}

function init() {
  el('new-event').addEventListener('click', () => openEventDialog(null));
  el('empty-new').addEventListener('click', () => openEventDialog(null));
  el('event-form').addEventListener('submit', submitEventForm);
  el('dialog-cancel').addEventListener('click', closeEventDialog);
  el('dialog-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'dialog-backdrop') closeEventDialog();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEventDialog(); });

  let searchTimer;
  el('search').addEventListener('input', (e) => {
    state.search = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadEvents().catch((err) => toast(err.message, true)), 250);
  });

  loadEvents().catch((err) => toast(err.message, true));
}

async function bootstrap() {
  // サーバーAPIがあればサーバーモード、無ければ localStorage モードにする
  try {
    if (window.prepareStore) await window.prepareStore();
  } catch (_) { /* ignore */ }
  init();
}

document.addEventListener('DOMContentLoaded', bootstrap);
