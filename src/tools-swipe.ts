import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./index.js";
import {
  addSwipe, searchSwipes, getSwipe, updateSwipe, markUsed, listTagCounts,
} from "./swipe-store.js";

/**
 * スワイプファイル MCP ツール群（要件定義 v1.7 §F4）。
 *
 * 入力スキーマは必ず z.object でプロパティを明示する。
 * z.record() を最上位に置くと MCP SDK の JSON Schema 変換が壊れ、
 * tools/list 全体が失敗する（技術鉄則 §7.4）。
 */

export function asMcpTextResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

const CONTENT_AXIS = z.enum(["思考系", "習慣系", "攻略系", "その他"]);
const SOURCE_TYPE  = z.enum(["X", "note", "YouTube", "ブログ", "ノート", "PDF", "その他"]);
const STATUS       = z.enum(["未活用", "活用済", "reason未記入"]);
const VISIBILITY   = z.enum(["private", "sample"]);

export function registerSwipeTools(server: McpServer, env: Env): void {
  /* ── 1. swipe__add ─────────────────────────────────────────────────── */
  server.tool(
    "swipe__add",
    "スワイプ（お手本・見本データ）を1件登録する。reason は必須。url と body は少なくとも一方が必要（両方でも可）。title / topic_tags / content_axis / excerpt / source_type を省略すると AI が補完する。タグは既存タグに寄せて提案される。戻り値: 登録されたレコード全体",
    {
      reason:       z.string().min(1).describe("なぜ優れているか1行。必須"),
      url:          z.string().optional().describe("出典URL。body が無い場合は必須"),
      body:         z.string().optional().describe("素材の中身そのもの（書き起こし・PDFから読んだ本文）。url が無い場合は必須"),
      title:        z.string().optional().describe("見出し。省略時は AI が生成"),
      topic_tags:   z.array(z.string()).optional().describe("キーワードタグ（自由入力）。省略時は AI が既存タグに寄せて提案"),
      source_type:  SOURCE_TYPE.optional().describe("媒体。省略時は URL・投入経路から自動判定"),
      content_axis: CONTENT_AXIS.optional().describe("発信の軸。省略時は AI が判定"),
      author:       z.string().optional().describe("発信者名"),
      excerpt:      z.string().optional().describe("一覧に出す短い抜粋（全角200字程度）。省略時は AI が生成"),
      visibility:   VISIBILITY.optional().describe("private（既定・自分用）/ sample（将来 生徒に見せる見本）"),
    },
    async (args) => asMcpTextResult({ ok: true, swipe: await addSwipe(env, args) })
  );

  /* ── 2. swipe__bulk_add ────────────────────────────────────────────── */
  server.tool(
    "swipe__bulk_add",
    "スワイプを複数件まとめて登録する。各件が swipe__add と同じ条件（reason 必須・url か body のいずれか必要）を満たすこと。1件ずつ処理し、失敗した件だけ理由を返す。戻り値: { ok, added, failed, results }",
    {
      items: z
        .array(
          z.object({
            reason:       z.string().min(1).describe("なぜ優れているか1行。必須"),
            url:          z.string().optional(),
            body:         z.string().optional(),
            title:        z.string().optional(),
            topic_tags:   z.array(z.string()).optional(),
            source_type:  SOURCE_TYPE.optional(),
            content_axis: CONTENT_AXIS.optional(),
            author:       z.string().optional(),
            excerpt:      z.string().optional(),
            visibility:   VISIBILITY.optional(),
          })
        )
        .min(1)
        .max(50)
        .describe("登録するスワイプの配列（最大50件）"),
    },
    async (args) => {
      const results: Array<{ index: number; ok: boolean; id?: string; error?: string }> = [];
      for (const [index, item] of args.items.entries()) {
        try {
          const swipe = await addSwipe(env, item);
          results.push({ index, ok: true, id: swipe.id });
        } catch (err) {
          results.push({ index, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return asMcpTextResult({
        ok:     true,
        added:  results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length,
        results,
      });
    }
  );

  /* ── 3. swipe__search（参照回数は増やさない） ──────────────────────── */
  server.tool(
    "swipe__search",
    "スワイプを条件検索する。keyword は title / reason / body / excerpt / author の部分一致。並び順は既定が登録日降順で、sort='ref' を明示したときだけ参照回数の多い順（同数は登録日降順）。このツールでは ref_count は増えない。戻り値: { ok, count, swipes }",
    {
      keyword:      z.string().optional().describe("部分一致で探す語"),
      tags:         z.array(z.string()).optional().describe("この全てのタグを含むものに絞る"),
      source_type:  SOURCE_TYPE.optional(),
      content_axis: CONTENT_AXIS.optional(),
      status:       STATUS.optional(),
      sort:         z.enum(["created", "ref"]).optional().describe("created=登録日降順（既定）/ ref=参照が多い順"),
      limit:        z.number().int().min(1).max(100).optional().describe("最大件数（既定20）"),
    },
    async (args) => {
      const swipes = await searchSwipes(env, args);
      return asMcpTextResult({ ok: true, count: swipes.length, swipes });
    }
  );

  /* ── 4. swipe__get（呼ぶたびに +1） ────────────────────────────────── */
  server.tool(
    "swipe__get",
    "ID指定でスワイプを1件フル取得する（body を含む）。呼び出すたびに ref_count が +1 され last_referenced_at が更新される。素材を実際に読むときだけ使うこと（一覧を眺めるだけなら swipe__search）。戻り値: { ok, swipe }",
    {
      id: z.string().min(1).describe("スワイプのID（swipe__search の戻り値に含まれる）"),
    },
    async (args) => asMcpTextResult({ ok: true, swipe: await getSwipe(env, args.id) })
  );

  /* ── 5. swipe__update（参照回数は更新対象外） ──────────────────────── */
  server.tool(
    "swipe__update",
    "スワイプを部分更新する。指定した項目だけ変更され、省略した項目は現在値を維持する。ref_count / last_referenced_at は更新できない。reason を空にする更新、および url / body / file_url がすべて空になる更新は拒否される。戻り値: { ok, swipe }",
    {
      id:           z.string().min(1).describe("スワイプのID"),
      reason:       z.string().optional(),
      url:          z.string().optional(),
      body:         z.string().optional(),
      title:        z.string().optional(),
      topic_tags:   z.array(z.string()).optional(),
      source_type:  SOURCE_TYPE.optional(),
      content_axis: CONTENT_AXIS.optional(),
      author:       z.string().optional(),
      excerpt:      z.string().optional(),
      status:       STATUS.optional(),
      used_in:      z.string().optional().describe("活用先の ContentOS 投稿ID・URL"),
      visibility:   VISIBILITY.optional(),
    },
    async (args) => asMcpTextResult({ ok: true, swipe: await updateSwipe(env, args) })
  );

  /* ── 6. swipe__mark_used（参照回数は増やさない） ───────────────────── */
  server.tool(
    "swipe__mark_used",
    "スワイプを「活用済」にし、活用先を記録する。ref_count は増えない。戻り値: { ok, swipe }",
    {
      id:      z.string().min(1).describe("スワイプのID"),
      used_in: z.string().optional().describe("活用先の ContentOS 投稿ID・URL（複数はカンマ区切り）"),
    },
    async (args) => asMcpTextResult({ ok: true, swipe: await markUsed(env, args.id, args.used_in) })
  );

  /* ── 7. swipe__list_tags ───────────────────────────────────────────── */
  server.tool(
    "swipe__list_tags",
    "使用中のタグを件数つきで一覧する。topic_tags は自由入力のため、同義語の乱立（表記ゆれ）を確認して寄せるために使う。新しくタグを付ける前にこれを見ること。戻り値: { ok, count, tags }",
    {},
    async () => {
      const tags = await listTagCounts(env);
      return asMcpTextResult({ ok: true, count: tags.length, tags });
    }
  );
}
