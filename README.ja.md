# mox (MailbOX)

【令和最新版】Cloudflare Email Workers を使用して神になる方法【バカでもできる】

## セットアップ

- Cloudflare のクイックデプロイボタンからデプロイできます
  [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yuimarudev/mox)  
- デプロイ時に環境変数を設定してください：`API_TOKEN`（必須）、`MAILBOX_MAX_MESSAGES`、`MAX_PARSE_BYTES`
- ローカル開発する場合は `.env.example` を `.env` にコピーし、`pnpm install` の後 `wrangler dev` を実行します。
- `API_TOKEN` は必須で、すべてのリクエストに `Authorization: Bearer <API_TOKEN>` を付けてください。
- 受信メールは R2 に EML と添付を保存し、Durable Object にメタデータを記録します。

## 例 (curl)

```bash
# 最新 5 件を取得
curl -H "Authorization: Bearer $API_TOKEN" \
  "http://localhost:8787/mailbox/alice?limit=5"

# メッセージのメタデータと本文を取得
curl -H "Authorization: Bearer $API_TOKEN" \
  "http://localhost:8787/mailbox/alice/<message-id>"

# 元の EML をダウンロード
curl -H "Authorization: Bearer $API_TOKEN" \
  -o message.eml \
  "http://localhost:8787/mailbox/alice/<message-id>/raw"

# 添付ファイル一覧
curl -H "Authorization: Bearer $API_TOKEN" \
  "http://localhost:8787/mailbox/alice/<message-id>/attachments"

# 特定の添付をダウンロード
curl -H "Authorization: Bearer $API_TOKEN" \
  -o attachment.bin \
  "http://localhost:8787/mailbox/alice/<message-id>/attachments/<attachment-id>"

# メールボックスを空にする
curl -X DELETE -H "Authorization: Bearer $API_TOKEN" \
  "http://localhost:8787/mailbox/alice"
```

## API ドキュメント

### 認証

- `API_TOKEN` は必須で、全エンドポイントで `Authorization: Bearer <token>` が必要です。

### レコード例

```json
{
  "ok": true,
  "message": {
    "id": "uuid",
    "receivedAt": "2024-01-01T00:00:00.000Z",
    "username": "alice",
    "to": "alice@example.com",
    "from": "bob@example.com",
    "subject": "Hello",
    "headers": { "subject": "Hello", "from": "bob@example.com" },
    "raw": { "r2Key": "raw/alice/2024-01-01/<id>.eml" },
    "parse": { "truncated": false, "maxBytes": 1000000 },
    "body": { "text": "hello", "html": "<p>hello</p>" },
    "attachments": [
      {
        "id": "uuid",
        "filename": "file.txt",
        "contentType": "text/plain",
        "size": 123,
        "r2Key": "att/alice/2024-01-01/<id>/…/file.txt",
        "inline": false,
        "contentId": null
      }
    ]
  }
}
```

### エンドポイント

- `GET /mailbox/:username?limit=50&cursor=<ts-key>`  
  最新メッセージを返します。`limit` は最大 200。`nextCursor` を使ってページングできます。

- `GET /mailbox/:username/:id`  
  メッセージ1件のメタデータと本文（テキスト/HTML 要約）を返します。

- `GET /mailbox/:username/:id/raw`  
  元の RFC822 (EML) を返します。

- `GET /mailbox/:username/:id/attachments`  
  添付のメタデータ一覧を返します。

- `GET /mailbox/:username/:id/attachments/:attachmentId`  
  添付をダウンロードします。`Content-Disposition` は `attachment` になります。

- `DELETE /mailbox/:username`  
  メールボックス内の全メッセージを削除します。

### 注意

- `MAILBOX_MAX_MESSAGES` を超えた場合、古いメッセージから順に削除されます。
- メールが `MAX_PARSE_BYTES` を超えると本文・添付のパースをスキップし、`parse.truncated: true` が返ります。
