// Genspark マネージド Cloudflare へのホスティング用 Worker エントリポイント。
//
// site/ ディレクトリの静的ファイルを ASSETS バインディング経由で配信する。
// アプリはブラウザの localStorage をデータ保存先として動作するため、
// サーバー側の API 実装（Express / D1 等）は不要。
//
// - /api/health へのアクセスにはサーバーが存在しない旨を返し、
//   フロントエンド（site/local-api.js）が localStorage モードへ切り替える。
// - それ以外のリクエストは静的アセットへ委譲する（未知のパスは index.html）。

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 静的配信モードであることをフロントエンドへ通知する。
    // local-api.js は /api/health が ok を返さない場合 localStorage モードに切り替える。
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ ok: false, mode: 'static' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    // 静的アセット（index.html / app.js / styles.css / local-api.js など）を配信。
    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
