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

## 提供するツール（8本・2026-10-23 スワイプくん 1便目）

ラベルは 6 つ：種類（shu）・参考ポイント（refs）・評価（grade S〜D）・ジャンル（genres）・分析の段（stage）・その他のラベル（labels）。
値は決まった値（sw_settings と、すでに使われている値）の中からだけ受け付ける。増やすのは Naoki が画面の「＋」で行う。

| ツール | 参照回数 | 役割 |
|---|---|---|
| `swipe__add` | 増えない | 1件足す。`url` か `body` のどちらかが必要。分析は空でもよい。置き場の省略時は X→今月の表、note→記事、ほかは未整理 |
| `swipe__bulk_add` | 増えない | 複数件まとめて足す（最大50件）。失敗した件だけ理由を返す |
| `swipe__search` | **増えない** | 6 つのラベル・置き場・Claude への依頼の印で探す。各件に `place`（置き場の名前）と `stage` が付く |
| `swipe__get` | **+1** | ID 指定で 1 件まるごと（本文の全文・線・使った記録） |
| `swipe__update` | 増えない | 部分更新 |
| `swipe__fill_analysis` | 増えない | Claude の分析の下書き。空いている段だけ書き、依頼の印を外す |
| `swipe__mark_used` | 増えない | 使った記録を足す（日付は日本時間の今日） |
| `swipe__list_tags` | 増えない | 選べる値と置き場の一覧（件数つき） |

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
| `ANTHROPIC_API_KEY` | 任意。見出し・抜粋の AI 補完用（無くても登録は通る） |

### 5. 動作確認
- `https://swipe-mcp.<アカウント名>.workers.dev/` → 稼働状況の JSON
- `https://swipe-mcp.<アカウント名>.workers.dev/diag` → Secrets と Supabase 接続の診断

### 6. Claude への接続
シアニン担当プロジェクトのコネクタとして `https://swipe-mcp.<アカウント名>.workers.dev/mcp` を追加する。

---

## まだ入っていないもの

- 素材パック・共有ページを名前で読む道具（スワイプくん 3便目）
