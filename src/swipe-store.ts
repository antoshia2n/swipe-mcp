import type { Env } from "./index.js";
import { TABLE, selectRows, insertRow, updateRow, callRpc, currentUserId } from "./supabase-client.js";
import { enrich, detectSourceType } from "./enrich.js";
import { deriveTitle, deriveExcerpt } from "./titling.js";
import { pushToZeus, type ZeusSyncResult } from "./zeus.js";

export interface Swipe {
  id: string;
  user_id: string;
  source_url: string | null;
  body: string | null;
  reason: string;
  topic_tags: string[];
  title: string;
  /** 見出しを自動で付けたか。人が指定した見出しなら false（作り直しの対象外） */
  title_auto: boolean;
  source_type: string;
  author: string | null;
  excerpt: string | null;
  content_axis: string | null;
  status: string;
  used_in: string | null;
  file_url: string | null;
  visibility: string;
  zeus_synced: boolean;
  zeus_item_id: string | null;
  ref_count: number;
  last_referenced_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 一覧に出すときの本文プレビュー長（全角換算）。全文は swipe__get で取る。 */
const BODY_PREVIEW_CHARS = 120;

/** 検索結果1件。body は先頭だけの抜粋になっている（全文は含まない）。 */
export interface SwipeListItem extends Swipe {
  /** 本文の総文字数。0 なら本文なし */
  body_chars: number;
  /** true のとき body は途中まで。全文は swipe__get で取得する */
  body_truncated: boolean;
}

const STATUS_ACTIVE = "未活用";
const STATUS_USED   = "活用済";

/**
 * リンク先のページ題名・説明を取る。
 * アプリ側に既にある /api/ogp を呼ぶだけにして、同じ解析をここに作らない
 * （2026-07-17 Decision「外部ベータ API への直依存禁止・車輪を集める」に沿う）。
 * 取れなくても登録は止めない。
 */
async function fetchPageMeta(env: Env, url: string): Promise<{ title: string; description: string }> {
  const base = (env.SWIPE_APP_BASE ?? "").replace(/\/$/, "");
  if (!base || !/^https?:\/\//i.test(url)) return { title: "", description: "" };

  try {
    const res = await fetch(`${base}/api/ogp`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url }),
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) return { title: "", description: "" };
    const data = (await res.json()) as { fetched?: boolean; title?: string | null; description?: string | null };
    if (!data?.fetched) return { title: "", description: "" };
    return { title: data.title ?? "", description: data.description ?? "" };
  } catch {
    return { title: "", description: "" };
  }
}

/** 保存の最低条件（要件 v1.7 §5 F1・受け入れ基準5）。DB 側にも同じ制約がある。 */
function assertSavable(input: { reason?: string; title?: string; url?: string; body?: string; file_url?: string }): void {
  const reason = (input.reason ?? "").trim();
  const title  = (input.title ?? "").trim();
  const has =
    (input.url ?? "").trim().length > 0 ||
    (input.body ?? "").trim().length > 0 ||
    (input.file_url ?? "").trim().length > 0;

  if (!reason) throw new Error("reason_required: なぜ良いか・要約の1行は必須です");
  if (!title)  throw new Error("title_required: 見出しは必須です");
  if (!has)    throw new Error("substance_required: url / body / file_url のうち少なくとも1つが必要です");
}

/* ── 登録 ───────────────────────────────────────────────────────────────── */

export interface AddInput {
  reason: string;
  /** 見出し。必須（2026-07-29 の方針変更。AI が登録する運用が主のため人手はかからない） */
  title: string;
  url?: string;
  body?: string;
  topic_tags?: string[];
  source_type?: string;
  author?: string;
  excerpt?: string;
  content_axis?: string;
  visibility?: string;
}

export interface AddResult {
  swipe: Swipe;
  /** AI 補完が実際に効いたか。false のときは見出し・タグが機械的な埋め合わせになる */
  ai_enriched: boolean;
  /** Zeus 索引への登録結果（失敗しても登録自体は成功している） */
  zeus: ZeusSyncResult;
}

export async function addSwipe(env: Env, input: AddInput): Promise<AddResult> {
  assertSavable(input);

  const url    = (input.url ?? "").trim();
  const body   = (input.body ?? "").trim();
  const reason = input.reason.trim();

  // 省略された項目だけ AI に埋めさせる（指定済みの値は上書きしない）
  const needsEnrich =
    !input.title || !input.topic_tags?.length || !input.content_axis || !input.excerpt || !input.source_type;
  const ai = needsEnrich ? await enrich(env, { url, body, reason }) : {};
  const aiWorked = Object.values(ai).some(v => v !== undefined);

  // 見出しと抜粋は1か所の規則で決める（src/titling.ts）。
  // アプリ側の src/lib/titling.js と同じ内容にしてあるので、
  // 画面から入れても AI から入れても同じ見出しになる。
  // URL があるときはページの題名を取りに行く（AI が使えない期間でもここは効く）。
  const page = url ? await fetchPageMeta(env, url) : { title: "", description: "" };

  const titled = deriveTitle({
    manualTitle: input.title,
    pageTitle:   page.title,
    aiTitle:     ai.title,
    body,
  });
  const excerpt = deriveExcerpt({
    manualExcerpt:   input.excerpt,
    aiExcerpt:       ai.excerpt,
    pageDescription: page.description,
    body,
  });

  const row = {
    user_id:      currentUserId(env),
    source_url:   url || null,
    body:         body || null,
    reason,
    title:        titled.title,
    title_auto:   titled.auto,
    topic_tags:   input.topic_tags?.length ? input.topic_tags : (ai.topic_tags ?? []),
    source_type:  input.source_type ?? ai.source_type ?? detectSourceType(url, body.length > 0),
    author:       input.author ?? ai.author ?? null,
    excerpt:      excerpt || null,
    content_axis: input.content_axis ?? ai.content_axis ?? null,
    visibility:   input.visibility ?? "private",
    status:       STATUS_ACTIVE,
    zeus_synced:  false,
  };

  const inserted = await insertRow<Swipe>(env, TABLE, row);
  // Zeus 索引へ登録する。失敗しても登録は成立させる（§F5）
  const zeus = await pushToZeus(env, inserted);

  // 同期後の値を返す。挿入直後のスナップショットを返すと
  // zeus_synced=false のまま見えて「連携失敗」と読み違えるため。
  let swipe = inserted;
  if (zeus.status === "pushed") {
    swipe = await fetchWithoutCounting(env, inserted.id).catch(() => inserted);
  }
  return { swipe, ai_enriched: aiWorked, zeus };
}

/* ── 検索（参照回数は増やさない・受け入れ基準8） ─────────────────────────── */

export interface SearchInput {
  keyword?: string;
  tags?: string[];
  source_type?: string;
  content_axis?: string;
  status?: string;
  sort?: "created" | "ref";
  limit?: number;
}

// PostgREST の or 条件を壊す文字を落とす
function safeKeyword(kw: string): string {
  return kw.replace(/[,()%*\\"']/g, " ").trim();
}

/**
 * 一覧用に本文を切り詰める。
 * 検索は「どれを読むか選ぶ」ための操作なので、本文全文は返さない
 * （長文素材が1件混ざるだけで呼び出し側の読み込み量が跳ね上がるため）。
 */
function toListItem(row: Swipe): SwipeListItem {
  const full  = row.body ?? "";
  const chars = full.length;
  const cut   = chars > BODY_PREVIEW_CHARS;
  return {
    ...row,
    body: chars ? (cut ? `${full.slice(0, BODY_PREVIEW_CHARS)}…` : full) : null,
    body_chars: chars,
    body_truncated: cut,
  };
}

export async function searchSwipes(env: Env, input: SearchInput): Promise<SwipeListItem[]> {
  const uid    = currentUserId(env);
  const params: string[] = [`user_id=eq.${encodeURIComponent(uid)}`, "select=*"];

  const kw = safeKeyword(input.keyword ?? "");
  if (kw) {
    const like = `*${kw}*`;
    params.push(
      `or=${encodeURIComponent(
        `(title.ilike.${like},reason.ilike.${like},body.ilike.${like},excerpt.ilike.${like},author.ilike.${like})`
      )}`
    );
  }
  if (input.tags?.length) {
    params.push(`topic_tags=cs.${encodeURIComponent(`{${input.tags.join(",")}}`)}`);
  }
  if (input.source_type)  params.push(`source_type=eq.${encodeURIComponent(input.source_type)}`);
  if (input.content_axis) params.push(`content_axis=eq.${encodeURIComponent(input.content_axis)}`);
  if (input.status)       params.push(`status=eq.${encodeURIComponent(input.status)}`);

  // 既定は登録日降順。参照順は明示指定されたときだけ（要件 §F3・受け入れ基準9）
  params.push(input.sort === "ref" ? "order=ref_count.desc,created_at.desc" : "order=created_at.desc");
  params.push(`limit=${Math.min(Math.max(input.limit ?? 20, 1), 100)}`);

  const rows = await selectRows<Swipe>(env, `${TABLE}?${params.join("&")}`);
  return rows.map(toListItem);
}

/* ── 1件取得（呼び出しのたびに +1・要件 §F4「1回」の定義） ──────────────── */

export async function getSwipe(env: Env, id: string): Promise<Swipe> {
  await callRpc(env, "sw_increment_ref", { p_id: id });

  const uid  = currentUserId(env);
  const rows = await selectRows<Swipe>(
    env,
    `${TABLE}?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(uid)}&select=*`
  );
  if (!rows.length) throw new Error(`not_found: id=${id}`);
  return rows[0];
}

/* ── 部分更新（参照回数は対象外・要件 §F4） ─────────────────────────────── */

export interface UpdateInput {
  id: string;
  reason?: string;
  url?: string;
  body?: string;
  title?: string;
  topic_tags?: string[];
  source_type?: string;
  author?: string;
  excerpt?: string;
  content_axis?: string;
  status?: string;
  used_in?: string;
  visibility?: string;
}

export async function updateSwipe(env: Env, input: UpdateInput): Promise<Swipe> {
  const patch: Record<string, unknown> = {};
  if (input.reason       !== undefined) patch.reason       = input.reason.trim();
  if (input.url          !== undefined) patch.source_url   = input.url.trim() || null;
  if (input.body         !== undefined) patch.body         = input.body.trim() || null;
  if (input.title        !== undefined) {
    patch.title      = input.title;
    // 人が見出しを指定した＝以後は自動の作り直し対象から外す
    patch.title_auto = false;
  }
  if (input.topic_tags   !== undefined) patch.topic_tags   = input.topic_tags;
  if (input.source_type  !== undefined) patch.source_type  = input.source_type;
  if (input.author       !== undefined) patch.author       = input.author || null;
  if (input.excerpt      !== undefined) patch.excerpt      = input.excerpt || null;
  if (input.content_axis !== undefined) patch.content_axis = input.content_axis || null;
  if (input.status       !== undefined) patch.status       = input.status;
  if (input.used_in      !== undefined) patch.used_in      = input.used_in || null;
  if (input.visibility   !== undefined) patch.visibility   = input.visibility;

  if (!Object.keys(patch).length) throw new Error("no_fields: 更新する項目が指定されていません");

  // 保存の最低条件を壊す更新は受け付けない（現在値と突き合わせて判定する）。
  //
  // 注意：ここで ?? を使ってはいけない。空文字で更新すると patch の値は null になり、
  // ?? では「指定なし」と同じ扱いになって現在値へ落ちてしまう。その結果この検査を
  // 素通りし、DB 側の制約が英語のまま表に出ていた（2026-07-29 検出）。
  // 「項目が指定されたか」は patch にキーがあるかで判定する。
  const current = await fetchWithoutCounting(env, input.id);
  const nextValue = (key: string, fallback: string | null): string =>
    key in patch ? ((patch[key] as string | null) ?? "") : (fallback ?? "");

  assertSavable({
    reason:   nextValue("reason", current.reason),
    url:      nextValue("source_url", current.source_url),
    body:     nextValue("body", current.body),
    file_url: current.file_url ?? "",
  });

  return updateRow<Swipe>(env, TABLE, input.id, patch);
}

/** 参照回数を増やさずに1件取る（内部確認用） */
export async function fetchWithoutCounting(env: Env, id: string): Promise<Swipe> {
  const uid  = currentUserId(env);
  const rows = await selectRows<Swipe>(
    env,
    `${TABLE}?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(uid)}&select=*`
  );
  if (!rows.length) throw new Error(`not_found: id=${id}`);
  return rows[0];
}

/* ── 活用済マーク（参照回数は増やさない・受け入れ基準8） ─────────────────── */

export async function markUsed(env: Env, id: string, usedIn?: string): Promise<Swipe> {
  const patch: Record<string, unknown> = { status: STATUS_USED };
  if (usedIn !== undefined) patch.used_in = usedIn || null;
  return updateRow<Swipe>(env, TABLE, id, patch);
}

/* ── 使用中タグ一覧（表記ゆれ確認用・要件 §F4） ─────────────────────────── */

export async function listTagCounts(env: Env): Promise<Array<{ tag: string; count: number }>> {
  const uid  = currentUserId(env);
  const rows = await selectRows<{ topic_tags: string[] }>(
    env,
    `${TABLE}?user_id=eq.${encodeURIComponent(uid)}&select=topic_tags`
  );

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of row.topic_tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "ja"));
}
