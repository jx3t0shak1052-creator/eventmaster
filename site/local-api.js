'use strict';

/**
 * local-api.js — サーバーが無い（静的配信）環境でもアプリを動かすためのフォールバック。
 *
 * 仕組み:
 *  - 起動時に /api/health を試す。応答があれば「サーバーモード」で何もしない。
 *  - 応答が無ければ「ローカルモード」とし、window.fetch を差し替えて
 *    /api/* へのリクエストを localStorage 実装で処理する。
 *  - これにより app.js はサーバー有無を意識せず動ける。
 *
 * データはこのブラウザの localStorage に保存される。
 */

(function () {
  const DB_KEY = 'nomikai.db.v1';

  // ---------- ストレージ ----------
  function loadDb() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (!raw) return { events: [], participants: [], meta: { nextEventId: 1, nextParticipantId: 1 } };
      const db = JSON.parse(raw);
      db.events = Array.isArray(db.events) ? db.events : [];
      db.participants = Array.isArray(db.participants) ? db.participants : [];
      if (!db.meta) db.meta = { nextEventId: 1, nextParticipantId: 1 };
      return db;
    } catch (_) {
      return { events: [], participants: [], meta: { nextEventId: 1, nextParticipantId: 1 } };
    }
  }
  function saveDb(db) {
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) {
      // 容量超過など
      throw new Error('保存に失敗しました（ブラウザのストレージ容量不足の可能性）');
    }
  }

  // ---------- ロジック（サーバー実装と同等） ----------
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^\d{2}:\d{2}$/;

  function validateEvent(body) {
    const errors = [];
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) errors.push('name は必須です');
    if (name.length > 120) errors.push('name は120文字以内です');
    const date = typeof body.date === 'string' ? body.date.trim() : '';
    if (date && !DATE_RE.test(date)) errors.push('date は YYYY-MM-DD 形式です');
    const time = typeof body.time === 'string' ? body.time.trim() : '';
    if (time && !TIME_RE.test(time)) errors.push('time は HH:MM 形式です');
    const venue = typeof body.venue === 'string' ? body.venue.trim() : '';
    if (venue.length > 200) errors.push('venue は200文字以内です');
    let fee = 0;
    if (body.fee !== undefined && body.fee !== null && body.fee !== '') {
      fee = Number(body.fee);
      if (!Number.isFinite(fee) || fee < 0) errors.push('fee は0以上の数値です');
    }
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > 1000) errors.push('note は1000文字以内です');
    return { errors, value: { name, date, time, venue, fee: Math.round(fee), note } };
  }

  function validateParticipant(body) {
    const errors = [];
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) errors.push('name は必須です');
    if (name.length > 80) errors.push('name は80文字以内です');
    const paid = body.paid === true || body.paid === 'true';
    const memo = typeof body.memo === 'string' ? body.memo.trim() : '';
    if (memo.length > 300) errors.push('memo は300文字以内です');
    const group = typeof body.group === 'string' ? body.group.trim() : '';
    let fee = null;
    if (body.fee !== undefined && body.fee !== null && body.fee !== '') {
      fee = Number(body.fee);
      if (!Number.isFinite(fee) || fee < 0) errors.push('fee は0以上の数値です');
      else fee = Math.round(fee);
    }
    return { errors, value: { name, paid, memo, group, fee } };
  }

  const effectiveFee = (p, base) => (p.fee !== null && p.fee !== undefined ? p.fee : (base || 0));

  function toPublicEvent(db, ev) {
    const parts = db.participants.filter((p) => p.eventId === ev.id);
    const base = ev.fee || 0;
    let expected = 0, collected = 0;
    const participants = parts.map((p) => {
      const amount = effectiveFee(p, base);
      expected += amount;
      if (p.paid) collected += amount;
      return Object.assign({}, p, { amount });
    });
    const paid = parts.filter((p) => p.paid).length;
    return Object.assign({}, ev, {
      participants,
      stats: { participants: parts.length, paid, unpaid: parts.length - paid, collected, expected },
    });
  }

  function nowIso() { return new Date().toISOString(); }

  // ---------- ルーティング ----------
  function handle(rawPath, method, body) {
    const u = new URL(rawPath, 'http://local');
    const path = u.pathname;
    const q = (u.searchParams.get('q') || '').trim().toLowerCase();
    const db = loadDb();
    const seg = path.split('/').filter(Boolean); // ['api','events',...]

    const err = (status, message, details) => ({ status, body: { error: message, details } });
    const ok = (status, b) => ({ status, body: b });

    try {
      // /api/health
      if (seg[1] === 'health') return ok(200, { ok: true, time: nowIso(), mode: 'local' });

      // /api/export
      if (seg[1] === 'export') return ok(200, db);

      // /api/events...
      if (seg[1] === 'events') {
        // /api/events
        if (seg.length === 2) {
          if (method === 'GET') {
            let events = db.events.map((ev) => toPublicEvent(db, ev));
            if (q) events = events.filter((ev) => ev.name.toLowerCase().includes(q) || (ev.venue || '').toLowerCase().includes(q));
            events.sort((a, b) => {
              const da = a.date || '', dbv = b.date || '';
              if (da && dbv && da !== dbv) return dbv.localeCompare(da);
              return (b.id || 0) - (a.id || 0);
            });
            return ok(200, { events });
          }
          if (method === 'POST') {
            const v = validateEvent(body || {});
            if (v.errors.length) return err(400, '入力内容に誤りがあります', v.errors);
            const id = db.meta.nextEventId++;
            const rec = Object.assign({ id }, v.value, { createdAt: nowIso(), updatedAt: nowIso() });
            db.events.push(rec); saveDb(db);
            return ok(201, { event: toPublicEvent(db, rec) });
          }
        }
        // /api/events/:id
        if (seg.length === 3) {
          const id = Number(seg[2]);
          const target = db.events.find((e) => e.id === id);
          if (!target) return err(404, 'イベントが見つかりません');
          if (method === 'GET') return ok(200, { event: toPublicEvent(db, target) });
          if (method === 'PUT') {
            const v = validateEvent(body || {});
            if (v.errors.length) return err(400, '入力内容に誤りがあります', v.errors);
            Object.assign(target, v.value, { updatedAt: nowIso() });
            saveDb(db);
            return ok(200, { event: toPublicEvent(db, target) });
          }
          if (method === 'DELETE') {
            db.events = db.events.filter((e) => e.id !== id);
            db.participants = db.participants.filter((p) => p.eventId !== id);
            saveDb(db);
            return ok(200, { ok: true });
          }
        }
        // /api/events/:id/participants
        if (seg.length === 4 && seg[3] === 'participants') {
          const id = Number(seg[2]);
          const ev = db.events.find((e) => e.id === id);
          if (!ev) return err(404, 'イベントが見つかりません');
          if (method === 'GET') return ok(200, { participants: db.participants.filter((p) => p.eventId === id) });
          if (method === 'POST') {
            const v = validateParticipant(body || {});
            if (v.errors.length) return err(400, '入力内容に誤りがあります', v.errors);
            const pid = db.meta.nextParticipantId++;
            const rec = Object.assign({ id: pid, eventId: id }, v.value, { createdAt: nowIso(), updatedAt: nowIso() });
            db.participants.push(rec); saveDb(db);
            return ok(201, { participant: rec });
          }
        }
        // /api/events/:id/summary
        if (seg.length === 4 && seg[3] === 'summary') {
          const id = Number(seg[2]);
          const ev = db.events.find((e) => e.id === id);
          if (!ev) return err(404, 'イベントが見つかりません');
          const parts = db.participants.filter((p) => p.eventId === id);
          const base = ev.fee || 0;
          let expected = 0, collected = 0;
          const unpaidNames = [];
          for (const p of parts) {
            const amount = effectiveFee(p, base);
            expected += amount;
            if (p.paid) collected += amount; else unpaidNames.push(p.name);
          }
          return ok(200, {
            summary: {
              eventId: ev.id, fee: base,
              participants: parts.length,
              paid: parts.filter((p) => p.paid).length,
              unpaid: parts.filter((p) => !p.paid).length,
              collected, expected, unpaidNames,
            },
          });
        }
      }

      // /api/participants/:id
      if (seg[1] === 'participants' && seg.length === 3) {
        const id = Number(seg[2]);
        const target = db.participants.find((p) => p.id === id);
        if (!target) return err(404, '参加者が見つかりません');
        if (method === 'PUT') {
          const merged = {
            name: body.name !== undefined ? body.name : target.name,
            paid: body.paid !== undefined ? body.paid : target.paid,
            memo: body.memo !== undefined ? body.memo : target.memo,
            group: body.group !== undefined ? body.group : target.group,
            fee: body.fee !== undefined ? body.fee : target.fee,
          };
          const v = validateParticipant(merged);
          if (v.errors.length) return err(400, '入力内容に誤りがあります', v.errors);
          Object.assign(target, v.value, { updatedAt: nowIso() });
          saveDb(db);
          return ok(200, { participant: target });
        }
        if (method === 'DELETE') {
          db.participants = db.participants.filter((p) => p.id !== id);
          saveDb(db);
          return ok(200, { ok: true });
        }
      }

      return err(404, 'Not found');
    } catch (e) {
      return err(500, e && e.message ? e.message : 'サーバーエラー');
    }
  }

  function makeResponse(res) {
    const text = JSON.stringify(res.body);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: { get: () => 'application/json' },
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  }

  function installLocalApi() {
    if (window.__localApiInstalled) return;
    window.__localApiInstalled = true;
    const orig = window.fetch.bind(window);
    window.fetch = function (input, init) {
      let path = typeof input === 'string' ? input : (input && input.url) || '';
      if (/^https?:\/\//i.test(path)) {
        try { const u = new URL(path); path = u.pathname + u.search; } catch (_) {}
      }
      if (path.indexOf('/api/') !== 0) return orig(input, init);
      const method = ((init && init.method) || 'GET').toUpperCase();
      let body;
      if (init && init.body) {
        try { body = JSON.parse(init.body); } catch (_) { body = undefined; }
      }
      const res = handle(path, method, body);
      return Promise.resolve(makeResponse(res));
    };
    window.__STORE_MODE__ = 'local';
  }

  // サーバーAPIの有無を判定して、無ければローカルモードを有効化
  window.prepareStore = async function () {
    try {
      const r = await fetch('/api/health', { headers: { 'Content-Type': 'application/json' } });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.ok) { window.__STORE_MODE__ = 'server'; return 'server'; }
      }
    } catch (_) { /* オフライン / 静的配信 */ }
    installLocalApi();
    return 'local';
  };
})();
