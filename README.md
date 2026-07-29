# swipe-mcp

スワイプファイル（お手本・見本データ）専用の MCP サーバー。Claude から `swipe__*` ツールで
素材の登録・検索・参照ができる。

- 要件：Notion「スワイプファイルアプリ 要件定義 v1.7」§F4
  https://app.notion.com/p/3ab9c6c1c439817abee4ee95f6a8a906
- 方式：**shia2n-mcp 本体とは完全に独立した Worker**（本体には追加しない・パス分割方式は使わない）
- 接続範囲：シアニン担当プロジェクトのみ

```
Claude（シアニン担当プロジェクト）
  ↓ MCP（OAuth / Bearer）
swipe-mcp（このアプリ・Cloudflare Workers）
  ↓ Supabase REST（service role）
sw_swipes / sw_zeus_orphans
```

---

## 提供するツール（7本）

| ツール | 参照回数 | 内容 |
|---|---|---|
| `swipe__add` | 増えない | 1件登録。`reason` 必須、`url` か `body` のいずれか必須 |
| `swipe__bulk_add` | 増えない | 複数件まとめて登録（最大50件）。失敗した件だけ理由を返す |
| `swipe__search` | **増えない** | 条件検索。既定は登録日降順、`sort=ref` のときだけ参照が多い順 |
| `swipe__get` | **+1** | ID指定で1件フル取得（`body` 含む） |
| `swipe__update` | 増えない | 部分更新。参照回数は更新できない |
| `swipe__mark_used` | **増えない** | 活用済マーク＋活用先の記録 |
| `swipe__list_tags` | 増えない | 使用中タグの一覧（表記ゆれ確認用） |

ファイル投入用のツールは作らない。AI は投入時点で中身をテキストで読めているため、
`swipe__add` の `body` に渡せば足りる（要件 §F4）。

---

## セットアップ

### 1. GitHub リポジトリ
`swipe-mcp` という名前で作成し、このファイル一式を Upload files で置く。

### 2. KV 名前空間
Cloudflare → Storage & Databases → KV → 名前空間 `swipe-mcp-oauth` を作成し、
その ID を `wrangler.jsonc` の `kv_namespaces[0].id` に入れる。

**shia2n-mcp と同じ名前空間を共用しないこと。**共用すると片方で発行した接続用トークンが
もう片方でも通ってしまう。

### 3. Cloudflare Workers（GitHub連携）
Workers & Pages → Create → Workers → Import a repository → `swipe-mcp`

- Build command : `npm install`
- Deploy command: `npx wrangler deploy`
- Root directory: （空欄）

### 4. Secrets（Settings → Variables and Secrets）

| 名前 | 値 |
|---|---|
| `MCP_SERVER_SECRET` | 新規のランダム文字列（64文字以上）。**shia2n-mcp とは別の値にする** |
| `MCP_DEFAULT_USER_ID` | Naoki の Firebase UID（スワイプアプリと同じ値） |
| `SUPABASE_URL` | 既存アプリと同じ |
| `SUPABASE_SERVICE_ROLE_KEY` | 既存アプリと同じ |
| `ANTHROPIC_API_KEY` | 既存アプリと同じ（AI補完用） |

### 5. 動作確認
- `https://swipe-mcp.<アカウント名>.workers.dev/` → 稼働状況の JSON
- `https://swipe-mcp.<アカウント名>.workers.dev/diag` → Secrets と Supabase 接続の診断

### 6. Claude への接続
シアニン担当プロジェクトのコネクタとして `https://swipe-mcp.<アカウント名>.workers.dev/mcp` を追加する。

---

## まだ入っていないもの

- **Zeus 索引への自動連携（F5）**：登録時の push は次のブロックで実装する
- **ファイル取り込み（F7）**：画面アップロードのみの機能で、MCP 側には作らない
