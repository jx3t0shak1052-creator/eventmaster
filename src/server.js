'use strict';

const express = require('express');
const path = require('path');
const { read, mutate } = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
// フロントエンドは site/ に配置（静的ホスティングでも配信できるようにするため）
app.use(express.static(path.join(__dirname, '..', 'site')));

function sendError(res, status, message, details) {
  return res.status(status).json({ error: message, details: details || undefined });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function validateEventInput(body) {
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
  const feeRaw = body.fee;
  let fee = 0;
  if (feeRaw !== undefined && feeRaw !== null && feeRaw !== '') {
    fee = Number(feeRaw);
    if (!Number.isFinite(fee) || fee < 0) errors.push('fee は0以上の数値です');
  }
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > 1000) errors.push('note は1000文字以内です');
  return { errors, value: { name, date, time, venue, fee: Math.round(fee), note } };
}

function validateParticipantInput(body) {
  const errors = [];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) errors.push('name は必須です');
  if (name.length > 80) errors.push('name は80文字以内です');
  const paid = body.paid === true || body.paid === 'true';
  const memo = typeof body.memo === 'string' ? body.memo.trim() : '';
  if (memo.length > 300) errors.push('memo は300文字以内です');
  const group = typeof body.group === 'string' ? body.group.trim() : '';

  // 個別参加費: 未指定(null/空)ならイベントの既定参加費を使う
  let fee = null;
  const feeRaw = body.fee;
  if (feeRaw !== undefined && feeRaw !== null && feeRaw !== '') {
    fee = Number(feeRaw);
    if (!Number.isFinite(fee) || fee < 0) errors.push('fee は0以上の数値です');
    else fee = Math.round(fee);
  }

  return { errors, value: { name, paid, memo, group, fee } };
}

/** その参加者に適用される参加費（個別設定があればそれ、なければイベント既定） */
function effectiveFee(participant, eventFee) {
  return participant.fee !== null && participant.fee !== undefined
    ? participant.fee
    : (eventFee || 0);
}

function toPublicEvent(db, ev) {
  const parts = db.participants.filter((p) => p.eventId === ev.id);
  const baseFee = ev.fee || 0;
  const paidCount = parts.filter((p) => p.paid).length;

  // 参加者ごとの参加費を合算して集計する
  let expected = 0;
  let collected = 0;
  const participants = parts.map((p) => {
    const amount = effectiveFee(p, baseFee);
    expected += amount;
    if (p.paid) collected += amount;
    return { ...p, amount };
  });

  return {
    ...ev,
    participants,
    stats: {
      participants: parts.length,
      paid: paidCount,
      unpaid: parts.length - paidCount,
      collected,
      expected,
    },
  };
}

app.get('/api/events', (req, res) => {
  const db = read();
  const q = (req.query.q || '').toString().trim().toLowerCase();
  let events = db.events.map((ev) => toPublicEvent(db, ev));
  if (q) {
    events = events.filter(
      (ev) => ev.name.toLowerCase().includes(q) || (ev.venue || '').toLowerCase().includes(q)
    );
  }
  events.sort((a, b) => {
    const da = a.date || '', dbv = b.date || '';
    if (da && dbv && da !== dbv) return dbv.localeCompare(da);
    return (b.id || 0) - (a.id || 0);
  });
  res.json({ events });
});

app.post('/api/events', async (req, res) => {
  const { errors, value } = validateEventInput(req.body || {});
  if (errors.length) return sendError(res, 400, '入力内容に誤りがあります', errors);
  const ev = await mutate((db) => {
    const id = db.meta.nextEventId++;
    const now = new Date().toISOString();
    const record = { id, ...value, createdAt: now, updatedAt: now };
    db.events.push(record);
    return record;
  });
  res.status(201).json({ event: toPublicEvent(read(), ev) });
});

app.get('/api/events/:id', (req, res) => {
  const db = read();
  const ev = db.events.find((e) => e.id === Number(req.params.id));
  if (!ev) return sendError(res, 404, 'イベントが見つかりません');
  res.json({ event: toPublicEvent(db, ev) });
});

app.put('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { errors, value } = validateEventInput(req.body || {});
  if (errors.length) return sendError(res, 400, '入力内容に誤りがあります', errors);
  let notFound = false;
  const ev = await mutate((db) => {
    const target = db.events.find((e) => e.id === id);
    if (!target) { notFound = true; return null; }
    Object.assign(target, value, { updatedAt: new Date().toISOString() });
    return target;
  });
  if (notFound || !ev) return sendError(res, 404, 'イベントが見つかりません');
  res.json({ event: toPublicEvent(read(), ev) });
});

app.delete('/api/events/:id', async (req, res) => {
  const id = Number(req.params.id);
  let notFound = false;
  await mutate((db) => {
    const idx = db.events.findIndex((e) => e.id === id);
    if (idx === -1) { notFound = true; return; }
    db.events.splice(idx, 1);
    db.participants = db.participants.filter((p) => p.eventId !== id);
  });
  if (notFound) return sendError(res, 404, 'イベントが見つかりません');
  res.json({ ok: true });
});

app.get('/api/events/:id/participants', (req, res) => {
  const db = read();
  const ev = db.events.find((e) => e.id === Number(req.params.id));
  if (!ev) return sendError(res, 404, 'イベントが見つかりません');
  res.json({ participants: db.participants.filter((p) => p.eventId === ev.id) });
});

app.post('/api/events/:id/participants', async (req, res) => {
  const eventId = Number(req.params.id);
  const db0 = read();
  if (!db0.events.find((e) => e.id === eventId)) return sendError(res, 404, 'イベントが見つかりません');
  const { errors, value } = validateParticipantInput(req.body || {});
  if (errors.length) return sendError(res, 400, '入力内容に誤りがあります', errors);
  const p = await mutate((db) => {
    const id = db.meta.nextParticipantId++;
    const now = new Date().toISOString();
    const record = { id, eventId, ...value, createdAt: now, updatedAt: now };
    db.participants.push(record);
    return record;
  });
  res.status(201).json({ participant: p });
});

app.put('/api/participants/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  let notFound = false, validationErrors = null;
  const result = await mutate((db) => {
    const target = db.participants.find((p) => p.id === id);
    if (!target) { notFound = true; return null; }
    const merged = {
      name: body.name !== undefined ? body.name : target.name,
      paid: body.paid !== undefined ? body.paid : target.paid,
      memo: body.memo !== undefined ? body.memo : target.memo,
      group: body.group !== undefined ? body.group : target.group,
      fee: body.fee !== undefined ? body.fee : target.fee,
    };
    const { errors, value } = validateParticipantInput(merged);
    if (errors.length) { validationErrors = errors; return null; }
    Object.assign(target, value, { updatedAt: new Date().toISOString() });
    return target;
  });
  if (validationErrors) return sendError(res, 400, '入力内容に誤りがあります', validationErrors);
  if (notFound || !result) return sendError(res, 404, '参加者が見つかりません');
  res.json({ participant: result });
});

app.delete('/api/participants/:id', async (req, res) => {
  const id = Number(req.params.id);
  let notFound = false;
  await mutate((db) => {
    const idx = db.participants.findIndex((p) => p.id === id);
    if (idx === -1) { notFound = true; return; }
    db.participants.splice(idx, 1);
  });
  if (notFound) return sendError(res, 404, '参加者が見つかりません');
  res.json({ ok: true });
});

app.get('/api/events/:id/summary', (req, res) => {
  const db = read();
  const ev = db.events.find((e) => e.id === Number(req.params.id));
  if (!ev) return sendError(res, 404, 'イベントが見つかりません');
  const parts = db.participants.filter((p) => p.eventId === ev.id);
  const baseFee = ev.fee || 0;

  let expected = 0;
  let collected = 0;
  const unpaidNames = [];
  for (const p of parts) {
    const amount = effectiveFee(p, baseFee);
    expected += amount;
    if (p.paid) collected += amount;
    else unpaidNames.push(p.name);
  }

  res.json({
    summary: {
      eventId: ev.id,
      fee: baseFee,
      participants: parts.length,
      paid: parts.filter((p) => p.paid).length,
      unpaid: parts.filter((p) => !p.paid).length,
      collected,
      expected,
      unpaidNames,
    },
  });
});

app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="nomikai-export.json"');
  res.json(read());
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'site', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  sendError(res, 500, 'サーバーエラーが発生しました');
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`飲み会管理アプリ: http://localhost:${PORT}`));
}

module.exports = app;
