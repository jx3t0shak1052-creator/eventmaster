'use strict';

/**
 * 簡易APIテスト（外部テストフレームワーク不要）
 * 実行: node test/api.test.js
 * 一時データディレクトリを使うため、既存データには影響しません。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

// 一時データディレクトリを指定してからサーバーを読み込む
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nomikai-test-'));
process.env.DATA_DIR = TMP;

const app = require('../src/server');

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.error('  ✗ ' + label); }
}

function req(server, method, url, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1', port, path: url, method,
      headers: { 'Content-Type': 'application/json' },
    };
    const r = http.request(options, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  const server = app.listen(0);
  await new Promise((res) => server.once('listening', res));

  try {
    console.log('\n[1] イベント作成');
    let r = await req(server, 'POST', '/api/events', {
      name: '歓迎会', date: '2026-09-20', time: '19:00', venue: '居酒屋', fee: 5000,
    });
    assert(r.status === 201, '201 で作成される');
    assert(r.body.event.name === '歓迎会', '名前が保存される');
    assert(r.body.event.fee === 5000, '参加費が保存される');
    const eventId = r.body.event.id;

    console.log('\n[2] バリデーション');
    r = await req(server, 'POST', '/api/events', { name: '', date: '2026-09-20' });
    assert(r.status === 400, '名前なしは 400');
    r = await req(server, 'POST', '/api/events', { name: 'x', date: '2026/1/1' });
    assert(r.status === 400, '不正な日付形式は 400');
    r = await req(server, 'POST', '/api/events', { name: 'x', fee: -100 });
    assert(r.status === 400, '負の参加費は 400');

    console.log('\n[3] 参加者の追加');
    const names = ['田中', '佐藤', '鈴木'];
    const ids = [];
    for (const n of names) {
      r = await req(server, 'POST', `/api/events/${eventId}/participants`, { name: n });
      assert(r.status === 201, `参加者「${n}」を追加`);
      ids.push(r.body.participant.id);
    }
    r = await req(server, 'GET', `/api/events/${eventId}/participants`);
    assert(r.body.participants.length === 3, '参加者が3名登録されている');

    console.log('\n[4] 支払いトグルと集計');
    await req(server, 'PUT', `/api/participants/${ids[0]}`, { paid: true });
    r = await req(server, 'GET', `/api/events/${eventId}/summary`);
    assert(r.body.summary.paid === 1, '支払済が1名');
    assert(r.body.summary.unpaid === 2, '未払いが2名');
    assert(r.body.summary.collected === 5000, '集金済みが 5000 円');
    assert(r.body.summary.expected === 15000, '予定額が 15000 円');
    assert(r.body.summary.unpaidNames.length === 2, '未払い者名が取得できる');

    console.log('\n[5] 部分更新（支払いのみ）で名前が壊れない');
    await req(server, 'PUT', `/api/participants/${ids[1]}`, { paid: true });
    r = await req(server, 'GET', `/api/events/${eventId}/participants`);
    const sato = r.body.participants.find((p) => p.id === ids[1]);
    assert(sato.name === '佐藤', '名前が保持されている');
    assert(sato.paid === true, '支払い状態が更新されている');

    console.log('\n[5b] 参加者ごとの参加費');
    // 鈴木(ids[2])だけ参加費を 10000 円に個別設定（他はイベント既定5000）
    r = await req(server, 'PUT', `/api/participants/${ids[2]}`, { fee: 10000 });
    assert(r.status === 200, '個別参加費を更新できる');
    assert(r.body.participant.fee === 10000, '個別参加費が保存される');
    r = await req(server, 'GET', `/api/events/${eventId}/summary`);
    assert(r.body.summary.expected === 20000, '個別費を反映した予定額(5000+5000+10000)');
    assert(r.body.summary.collected === 10000, '支払済2名は既定費で集計(10000)');
    // 一覧APIで適用額(amount)が返る
    r = await req(server, 'GET', `/api/events/${eventId}`);
    const suzuki = r.body.event.participants.find((p) => p.id === ids[2]);
    assert(suzuki.amount === 10000, '参加者に適用額(amount)が付与される');
    // 個別設定を解除するとイベント既定費に戻る
    await req(server, 'PUT', `/api/participants/${ids[2]}`, { fee: null });
    r = await req(server, 'GET', `/api/events/${eventId}/summary`);
    assert(r.body.summary.expected === 15000, '個別費を解除すると既定費(5000)に戻る');
    // 不正値は 400
    r = await req(server, 'PUT', `/api/participants/${ids[2]}`, { fee: -1 });
    assert(r.status === 400, '負の個別参加費は 400');

    console.log('\n[6] 検索と一覧');
    r = await req(server, 'GET', '/api/events?q=' + encodeURIComponent('歓迎'));
    assert(r.body.events.length === 1, '名前で検索できる');
    r = await req(server, 'GET', '/api/events?q=' + encodeURIComponent('存在しない'));
    assert(r.body.events.length === 0, '該当なしは0件');

    console.log('\n[7] イベント更新');
    r = await req(server, 'PUT', `/api/events/${eventId}`, {
      name: '歓迎会(更新)', date: '2026-09-21', time: '20:00', venue: '居酒屋B', fee: 6000,
    });
    assert(r.body.event.name === '歓迎会(更新)', '名前が更新される');
    assert(r.body.event.fee === 6000, '参加費が更新される');

    console.log('\n[8] 404');
    r = await req(server, 'GET', '/api/events/99999');
    assert(r.status === 404, '存在しないイベントは 404');

    console.log('\n[9] 削除（カスケード）');
    r = await req(server, 'DELETE', `/api/events/${eventId}`);
    assert(r.status === 200, 'イベント削除が成功');
    r = await req(server, 'GET', '/api/events');
    assert(r.body.events.length === 0, 'イベントが消えている');
    r = await req(server, 'GET', '/api/export');
    assert(r.body.participants.length === 0, '紐づく参加者も削除されている');

    console.log('\n[10] 永続化ファイル');
    assert(fs.existsSync(path.join(TMP, 'db.json')), 'db.json が保存されている');
  } finally {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
