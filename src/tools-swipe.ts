import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./index.js";
import {
  addSwipe, addContext, searchSwipes, getSwipe, updateSwipe, fillAnalysis, markUsed, listVocabulary, listPacks, getPack, STAGES,
} from "./swipe-store.js";

/**
 * スワイプくん MCP ツール群（2026-10-23 スワイプくん 1便目で作り替え）。
 *
 * ラベルは 6 つ：種類（shu）・参考ポイント（refs）・評価（grade）・ジャンル（genres）・分析の段（stage）・その他のラベル（labels）。
 * 値は決まった値の中からだけ受け付ける（swipe__list_tags で一覧できる。増やすのは Naoki が画面で行う）。
 *
 * 入力スキーマは必ず z.object でプロパティを明示する。
 * z.record() を最上位に置くと MCP SDK の JSON Schema 変換が壊れ、tools/list 全体が失敗する（技術鉄則 §7.4）。
 */

export function asMcpTextResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

const SOURCE_TYPE = z.enum(["X", "note", "YouTube", "ブログ", "ノート", "PDF", "その他"]);
const GRADE = z.enum(["S", "A", "B", "C", "D"]);
const STAGE = z.enum(STAGES);
const VISIBILITY = z.enum(["private", "sample"]);

const addShape = {
  title: z.string().optional().describe("見出し。省略時はリンク先の題名か本文の書き出しから付ける"),
  reason: z.string().optional().describe("分析 1 段目「言語化」：なぜ良いか。空でも保存できる（未分析のまま）"),
  hypo: z.string().optional().describe("分析 2 段目「仮説」：ほかでも効きそうな型"),
  idea: z.string().optional().describe("分析 3 段目「用途抽出」：どこで・どう使うかを文章で"),
  url: z.string().optional().describe("出典 URL。body が無い場合は必須"),
  body: z.string().optional().describe("中身そのもの（ポスト本文・書き起こし）。url が無い場合は必須"),
  table: z.string().optional().describe("置き場の表 ID（swipe__list_tags の tables）。省略時は X と YouTube→今月の表、note→記事、ほかは未整理"),
  shu: z.string().optional().describe("種類（決まった値から：ポスト・記事・教材・販売ページ など）。省略時は媒体から決める"),
  refs: z.array(z.string()).optional().describe("参考ポイント（決まった値から：構文・内容・セールスの流れ・実績の見せ方 など）"),
  grade: GRADE.optional().describe("評価 S〜D"),
  genres: z.array(z.string()).optional().describe("ジャンル（決まった値から）"),
  labels: z.array(z.string()).optional().describe("その他のラベル（決まった値から）"),
  ai_ask: z.boolean().optional().describe("true にすると「Claude に分析を頼んだ」の列に入る"),
  author: z.string().optional().describe("発信者名"),
  source_type: SOURCE_TYPE.optional().describe("媒体。省略時は URL から自動"),
  excerpt: z.string().optional().describe("一覧に出す短い抜粋。省略時は自動"),
  visibility: VISIBILITY.optional(),
};

export function registerSwipeTools(server: McpServer, env: Env): void {
  server.tool(
    "swipe__add",
    "スワイプくんに 1 件足す。url か body のどちらかが必要。ラベル（shu / refs / genres / labels）と置き場（table）は決まった値の中からだけ指定できる（先に swipe__list_tags で確かめる）。分析（reason / hypo / idea）は空でもよい。戻り値: { ok, ai_enriched, swipe }",
    addShape,
    async (args) => {
      const { swipe, ai_enriched } = await addSwipe(env, args);
      return asMcpTextResult({ ok: true, ai_enriched, swipe });
    },
  );

  server.tool(
    "swipe__bulk_add",
    "スワイプを複数件まとめて足す（最大 50 件）。各件の条件は swipe__add と同じ。1 件ずつ処理し、失敗した件だけ理由を返す。戻り値: { ok, added, failed, results }",
    { items: z.array(z.object(addShape)).min(1).max(50).describe("足すスワイプの配列") },
    async (args) => {
      const ctx = await addContext(env);
      const results: Array<{ index: number; ok: boolean; id?: string; place?: string; error?: string }> = [];
      for (const [index, item] of args.items.entries()) {
        try {
          const { swipe } = await addSwipe(env, item, ctx);
          results.push({ index, ok: true, id: swipe.id, place: swipe.place });
        } catch (err) {
          results.push({ index, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return asMcpTextResult({ ok: true, added: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
    },
  );

  server.tool(
    "swipe__search",
    "スワイプを探す。種類・参考ポイント・評価・ジャンル・分析の段・ラベル・置き場・Claude への依頼の印で絞れる。keyword は見出し・本文・分析 3 段・抜粋・投稿者の部分一致。戻り値の body は先頭 120 字だけ（全文は swipe__get）。各件に place（置き場の名前）と stage（未分析・言語化・仮説・用途抽出）が付く。ref_count は増えない。戻り値: { ok, count, swipes }",
    {
      keyword: z.string().optional().describe("部分一致で探す語"),
      shu: z.string().optional().describe("種類"),
      ref: z.string().optional().describe("参考ポイント（この値を含むもの）"),
      grade_min: GRADE.optional().describe("この評価以上（A なら S と A）"),
      genre: z.string().optional().describe("ジャンル（この値を含むもの）"),
      label: z.string().optional().describe("その他のラベル（この値を含むもの）"),
      stage: STAGE.optional().describe("分析の段（未分析＝3 段とも空）"),
      ai_ask: z.boolean().optional().describe("true で「Claude に分析を頼んだ」ものだけ"),
      table: z.string().optional().describe("置き場の表 ID。unsorted で未整理だけ"),
      source_type: SOURCE_TYPE.optional(),
      sort: z.enum(["created", "ref"]).optional().describe("created=保存日の新しい順（既定）/ ref=参照が多い順"),
      limit: z.number().int().min(1).max(100).optional().describe("最大件数（既定 20）"),
    },
    async (args) => {
      const swipes = await searchSwipes(env, args);
      return asMcpTextResult({ ok: true, count: swipes.length, swipes });
    },
  );

  server.tool(
    "swipe__get",
    "ID 指定でスワイプを 1 件まるごと取る（本文の全文・本文に引いた線・使った記録・種類ごとの欄を含む）。呼ぶたびに ref_count が +1。素材を実際に読むときだけ使う。戻り値: { ok, swipe }",
    { id: z.string().min(1).describe("スワイプの ID（swipe__search の戻り値）") },
    async (args) => asMcpTextResult({ ok: true, swipe: await getSwipe(env, args.id) }),
  );

  server.tool(
    "swipe__update",
    "スワイプを部分更新する。指定した項目だけ変わる。ラベルと置き場は決まった値の中からだけ。分析 3 段を上書きできるので、Claude が下書きを入れるときは swipe__fill_analysis を使う。url / body / file_url がすべて空になる更新は断る。戻り値: { ok, swipe }",
    {
      id: z.string().min(1).describe("スワイプの ID"),
      title: z.string().optional(),
      reason: z.string().optional().describe("言語化"),
      hypo: z.string().optional().describe("仮説"),
      idea: z.string().optional().describe("用途抽出"),
      url: z.string().optional(),
      body: z.string().optional(),
      table: z.string().optional().describe("置き場の表 ID。空文字で未整理へ"),
      shu: z.string().optional(),
      refs: z.array(z.string()).optional(),
      grade: z.enum(["S", "A", "B", "C", "D", ""]).optional().describe("空文字で評価なし"),
      genres: z.array(z.string()).optional(),
      labels: z.array(z.string()).optional(),
      ai_ask: z.boolean().optional(),
      author: z.string().optional(),
      excerpt: z.string().optional(),
      visibility: VISIBILITY.optional(),
    },
    async (args) => asMcpTextResult({ ok: true, swipe: await updateSwipe(env, args) }),
  );

  server.tool(
    "swipe__fill_analysis",
    "Claude が分析の下書きを入れる。空いている段（言語化・仮説・用途抽出）だけに書き、すでに書いてある段は書き換えない。参考ポイントとジャンルも、空のときだけ候補を入れる（決まった値の中から）。書いたら「Claude に分析を頼んだ」の印を外す。頼まれたものは swipe__search の ai_ask=true で探す。戻り値: { ok, filled, kept, swipe }",
    {
      id: z.string().min(1).describe("スワイプの ID"),
      why: z.string().optional().describe("言語化：なぜ良いか"),
      hypo: z.string().optional().describe("仮説：ほかでも効きそうな型"),
      idea: z.string().optional().describe("用途抽出：どこで・どう使うかを文章で"),
      refs: z.array(z.string()).optional().describe("参考ポイントの候補"),
      genres: z.array(z.string()).optional().describe("ジャンルの候補"),
    },
    async (args) => {
      const r = await fillAnalysis(env, args);
      return asMcpTextResult({ ok: true, filled: r.filled, kept: r.kept, swipe: r.swipe });
    },
  );

  server.tool(
    "swipe__mark_used",
    "スワイプを「使った」にし、どこで使ったかを使った記録に足す（日付は今日・日本時間）。ref_count は増えない。戻り値: { ok, swipe }",
    {
      id: z.string().min(1).describe("スワイプの ID"),
      used_in: z.string().optional().describe("使った先（記事名・セミナー名・URL など）"),
    },
    async (args) => asMcpTextResult({ ok: true, swipe: await markUsed(env, args.id, args.used_in) }),
  );

  server.tool(
    "swipe__list_packs",
    "素材パック（Naoki が画面で、選んだスワイプと「作るもの」「目的」を 1 枚にまとめたもの）を一覧する。keyword で名前・目的を部分一致で絞れる。戻り値: { ok, count, packs: [{ id, name, make, goal, place, items, updated_at }] }",
    { keyword: z.string().optional().describe("名前・目的・作るものの部分一致") },
    async (args) => { const packs = await listPacks(env, args.keyword); return asMcpTextResult({ ok: true, count: packs.length, packs }); },
  );

  server.tool(
    "swipe__get_pack",
    "素材パックを 1 つ読む（名前か ID）。「素材パック『○○』で書いて」と言われたらこれを呼ぶ。見本のスワイプは全文・分析・線つきで返し、handoff はそのまま執筆の指示に使える渡す文。見本の文をそのまま写さず、参考ポイントの部分だけを借りる。ref_count は増えない。戻り値: { ok, pack, handoff, items }",
    { name: z.string().min(1).describe("素材パックの名前（完全一致を優先、無ければ部分一致）か ID") },
    async (args) => asMcpTextResult({ ok: true, ...(await getPack(env, args.name)) }),
  );

  server.tool(
    "swipe__list_tags",
    "選べる値と置き場を件数つきで一覧する。種類・参考ポイント・ジャンル・ラベルの決まった値、評価、分析の段、置き場の表（id と名前）。足す・直す・探す前にこれを見て、ここにある値だけを使う。戻り値: { ok, labels, stages, grades, tables, old_topic_tags }",
    {},
    async () => asMcpTextResult({ ok: true, ...(await listVocabulary(env)) }),
  );
}
