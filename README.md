# 串間市立串間中学校 ウェルカムボード

来賓玄関のサイネージ表示向けウェルカムボードです。

## 内容

- 歓迎メッセージ
- 現在日時
- 暑さ指数(WBGT)
- 気温・湿度
- WBGTデータの5分おき更新
- 5秒ごとに切り替わる今日の星座占い

星座占いの文言とラッキー教科は `kushima-horoscope.json` で管理します。

## WBGT自動更新

GitHub Actionsが5分おきに `scripts/update-wbgt-data.mjs` を実行し、`wbgt-live.json` を生成してGitHub Pagesへデプロイします。

GitHubの `Settings → Secrets and variables → Actions` に以下を設定してください。

- `WBGT_LOGIN_ID`: WBGTモニタリングサイトのログインID
- `WBGT_PASSWORD`: WBGTモニタリングサイトのパスワード

必要に応じて以下も設定できます。

- `WBGT_TARGET_URL`: ログイン後に取得するページURL
- `WBGT_DATA_URL`: JSON APIなど、直接取得できるデータURL
- `WBGT_DATA_AUTHORIZATION`: `WBGT_DATA_URL` 用のAuthorizationヘッダー

## ローカル確認

`index.html` をブラウザで開くか、簡易サーバーで確認します。

```powershell
python -m http.server 4280
```

その後、`http://127.0.0.1:4280/` を開きます。
