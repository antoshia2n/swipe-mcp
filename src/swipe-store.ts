import type { Env } from "./index.js";
import { TABLE, selectRows, insertRow, updateRow, callRpc, currentUserId } from "./supabase-client.js";
import { enrich, detectSourceType } from "./enrich.js";

export interface Swipe {
  id: string;
  user_id: string;
  source_url: string | null;
  body: string | null;
  reason: string;
  topic_tags: string[];
  title: string;
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

const STATUS_ACTIVE = "未活用";
const STATUS_USED   = "活用済";

/** 保存の最低条件（要件 v1.7 §5 F1・受け入れ基準5）。DB 側にも同じ制約がある。 */
function assertSavable(input: { reason?: string; url?: string; body?: string; file_url?: string }): void {
  const reason = (input.reason ?? "").trim();
  const has =
    (input.url ?? "").trim().length > 0 ||
    (input.body ?? "").trim().length > 0 ||
    (input.file_url ?? "").trim().length > 0;

  if (!reason) throw new Error("reason_required: なぜ良いかの1行は必須です");
  if (!has)    throw new Error("substance_required: url / body / file_url のうち少なくとも1つが必要です");
}

/* ── 登録 ───────────────────────────────────────────────────────────────── */

export interface AddInput {
  reason: string;
  url?: string;
  body?: string;
  title?: string;
  topic_tags?: string[];
  source_type?: string;
  author?: string;
  excerpt?: string;
  content_axis?: string;
  visibility?: string;
}

export async function addSwipe(env: Env, input: AddInput): Promise<Swipe> {
  assertSavable(input);

  const url    = (input.url ?? "").trim();
  const body   = (input.body ?? "").trim();
  const reason = input.reason.trim();

  // 省略された項目だけ AI に埋めさせる（指定済みの値は上書きしない）
  const needsEnrich =
    !input.title || !input.topic_tags?.length || !input.content_axis || !input.excerpt || !input.source_type;
  const ai = needsEnrich ? await enrich(env, { url, body, reason }) : {};

  const row = {
    user_id:      currentUserId(env),
    source_url:   url || null,
    body:         body || null,
    reason,
    title:        (input.title ?? ai.title ?? (url || reason)).slice(0, 200),
    topic_tags:   input.topic_tags?.length ? input.topic_tags : (ai.topic_tags ?? []),
    source_type:  input.source_type ?? ai.source_type ?? detectSourceType(url, body.length > 0),
    author:       input.author ?? ai.author ?? null,
    excerpt:      input.excerpt ?? ai.excerpt ?? null,
    content_axis: input.content_axis ?? ai.content_axis ?? null,
    visibility:   input.visibility ?? "private",
    status:       STATUS_ACTIVE,
    zeus_synced:  false,
  };

  return insertRow<Swipe>(env, TABLE, row);
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

export async function searchSwipes(env: Env, input: SearchInput): Promise<Swipe[]> {
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

  return selectRows<Swipe>(env, `${TABLE}?${params.join("&")}`);
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
  if (input.title        !== undefined) patch.title        = input.title;
  if (input.topic_tags   !== undefined) patch.topic_tags   = input.topic_tags;
  if (input.source_type  !== undefined) patch.source_type  = input.source_type;
  if (input.author       !== undefined) patch.author       = input.author || null;
  if (input.excerpt      !== undefined) patch.excerpt      = input.excerpt || null;
  if (input.content_axis !== undefined) patch.content_axis = input.content_axis || null;
  if (input.status       !== undefined) patch.status       = input.status;
  if (input.used_in      !== undefined) patch.used_in      = input.used_in || null;
  if (input.visibility   !== undefined) patch.visibility   = input.visibility;

  if (!Object.keys(patch).length) throw new Error("no_fields: 更新する項目が指定されていません");

  // 保存の最低条件を壊す更新は受け付けない（現在値と突き合わせて判定する）
  const current = await fetchWithoutCounting(env, input.id);
  assertSavable({
    reason:   (patch.reason as string | undefined) ?? current.reason,
    url:      (patch.source_url as string | null | undefined) ?? current.source_url ?? "",
    body:     (patch.body as string | null | undefined) ?? current.body ?? "",
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
