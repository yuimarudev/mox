# mox (MailbOX)

A blazingly fast and easy way to ~~abuse~~ use Cloudflare Email Workers

## Setup

- Deploy with the Cloudflare quick deploy button:  
  [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/your-org/mox)
- During deployment, set environment variables: `API_TOKEN` (required), `MAILBOX_MAX_MESSAGES`, `MAX_PARSE_BYTES`.
- For local dev, copy `.env.example` to `.env`, run `pnpm install`, then `wrangler dev`.
- `API_TOKEN` is mandatory; every request must include `Authorization: Bearer <API_TOKEN>`.
- Incoming mail is saved to R2 (raw EML + attachments) and indexed in a Durable Object.

## Examples

```bash
# List the latest 5 messages (with Bearer auth)
curl -H "Authorization: Bearer $API_TOKEN" \
  "http://localhost:8787/mailbox/alice?limit=5"

# Fetch a single message (metadata + parsed body)
curl -H "Authorization: Bearer $API_TOKEN" \
  "http://localhost:8787/mailbox/alice/<message-id>"

# Download the original EML
curl -H "Authorization: Bearer $API_TOKEN" \
  -o message.eml \
  "http://localhost:8787/mailbox/alice/<message-id>/raw"

# List attachments
curl -H "Authorization: Bearer $API_TOKEN" \
  "http://localhost:8787/mailbox/alice/<message-id>/attachments"

# Download a specific attachment
curl -H "Authorization: Bearer $API_TOKEN" \
  -o attachment.bin \
  "http://localhost:8787/mailbox/alice/<message-id>/attachments/<attachment-id>"

# Delete all messages in the mailbox
curl -X DELETE -H "Authorization: Bearer $API_TOKEN" \
  "http://localhost:8787/mailbox/alice"
```

## API Reference

### Authentication

- `API_TOKEN` is required and every endpoint expects `Authorization: Bearer <token>`.

### Record shape (response example)

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

### Endpoints

- `GET /mailbox/:username?limit=50&cursor=<ts-key>`  
  Returns the newest messages. `limit` up to 200. Use `nextCursor` for pagination.

- `GET /mailbox/:username/:id`  
  Returns one message (metadata + parsed text/html summaries).

- `GET /mailbox/:username/:id/raw`  
  Returns the original RFC822 (EML).

- `GET /mailbox/:username/:id/attachments`  
  Returns attachment metadata.

- `GET /mailbox/:username/:id/attachments/:attachmentId`  
  Downloads an attachment. `Content-Disposition` is `attachment`.

- `DELETE /mailbox/:username`  
  Deletes all messages for the mailbox.

### Notes

- `MAILBOX_MAX_MESSAGES` trims the oldest messages when the limit is exceeded.
- If a message exceeds `MAX_PARSE_BYTES`, parsing is skipped and `parse.truncated: true` is returned.
