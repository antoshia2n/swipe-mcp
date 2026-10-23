/**
 * swipe-mcp / src/swipe-store.ts / 第3版（2026-10-23 開発部・スワイプくん 1便目）
 *
 * 第3版で変えたこと
 *   - スワイプくんの列（置き場・種類・参考ポイント・評価・ジャンル・ラベル・仮説・用途抽出・Claude への依頼の印）を読み書きする
 *   - ラベルの値は、決まった値（sw_settings と、すでに使われている値）の中からだけ受け付ける
 *   - 言語化（reason）が空でも保存できる（未分析のまま貯められるように）
 *   - Zeus の索引連携は外した
 *
 * 第2版で直したこと（2026-08-25）
 *   updateSwipe の中で保存の最低条件を検査するとき、title を渡していなかった。
 */
import type { Env } from "./index.js";
import { TABLE, SETTINGS_TABLE, selectRows, insertRow, updateRow, callRpc, currentUserId } from "./supabase-client.js";
import { enrich, detectSourceType } from "./enrich.js";
import { deriveTitle, deriveExcerpt } from "./titling.js";

export interface Swipe {
  id: string;
  user_id: string;
  source_url: string | null;
  body: string | null;
  reason: string;
  topic_tags: string[];
  title: string;
  title_auto: boolean;
  source_type: string;
  author: string | null;
  excerpt: string | null;
  content_axis: string | null;
  status: string;
  used_in: string | null;
  file_url: string | null;
  visibility: string;
  ref_count: number;
  last_referenced_at: string | null;
  created_at: string;
  updated_at: string;
  // スワイプくん
  table_id: string | null;
  shu: string | null;
  refs: string[];
  grade: number;
  genres: string[];
  labels: string[];
  an_hypo: string;
  an_idea: string;
  highlights: Array<{ t: string; r: string }>;
  used_log: Array<{ w: string; d: string }>;
  props: Record<string, unknown>;
  ai_ask: boolean;
}

/** AI に返す 1 件。置き場の名前と分析の段を足し、使わない内部の列は落とす */
export interface SwipeOut {
  id: string;
  title: string;
  place: string;
  table_id: string | null;
  shu: string | null;
  refs: string[];
  grade: string;
  genres: string[];
  labels: string[];
  stage: string;
  analysis: { why: string; hypo: string; idea: string };
  ai_ask: boolean;
  url: string | null;
  author: string | null;
  excerpt: string | null;
  body: string | null;
  body_chars: number;
  body_truncated: boolean;
  file_url: string | null;
  image_url: string | null;
  highlights: Array<{ t: string; r: string }>;
  used_log: Array<{ w: string; d: string }>;
  fields: Record<string, unknown>;
  source_type: string;
  ref_count: number;
  created_at: string;
}

const BODY_PREVIEW_CHARS = 120;
export const STAGES = ["未分析", "言語化", "仮説", "用途抽出"] as const;
const GRADE_LETTER: Record<number, string> = { 5: "S", 4: "A", 3: "B", 2: "C", 1: "D", 0: "" };

/* ── 設定（フォルダ・表・選べる値）。画面の src/engine/app.js の既定と同じ ───── */

interface Settings {
  folders: Array<{ id: string; name: string; parent: string | null }>;
  tables: Array<{ id: string; name: string; folder: string }>;
  labels: { shu: string[]; ref: string[]; genre: string[]; tag: string[] };
}

const DEFAULT_SETTINGS: Settings = {
  folders: [
    { id: "f-x", name: "Xポスト", parent: null },
    { id: "f-note", name: "note", parent: null },
    { id: "f-lp", name: "情報商材", parent: null },
    { id: "f-mine", name: "自分の資料", parent: null },
  ],
  tables: [
    { id: "t-note", name: "記事", folder: "f-note" },
    { id: "t-lp-page", name: "販売ページ", folder: "f-lp" },
    { id: "t-lp-pdf", name: "教材PDF", folder: "f-lp" },
    { id: "t-mine-boshu", name: "募集告知", folder: "f-mine" },
    { id: "t-mine-seminar", name: "セミナー資料", folder: "f-mine" },
    { id: "t-mine-style", name: "文体基準", folder: "f-mine" },
    { id: "t-mine-rule", name: "ルール", folder: "f-mine" },
    { id: "t-mine-video", name: "動画", folder: "f-mine" },
  ],
  labels: {
    shu: ["ポスト", "記事", "教材", "販売ページ"],
    ref: ["構文", "内容", "セールスの流れ", "実績の見せ方"],
    genre: ["自己啓発", "X集客", "ライティング", "言語化", "マーケ", "習慣", "思考"],
    tag: ["募集告知", "セミナー資料", "文体基準", "有料教材", "販売ページ", "顧客の声", "自己開示", "スレッド", "図解"],
  },
};

const X_MONTH = /^x-(\d{4})-(\d{2})$/;

export async function loadSettings(env: Env): Promise<Settings> {
  const uid = currentUserId(env);
  const rows = await selectRows<{ data: Partial<Settings> }>(env, `${SETTINGS_TABLE}?user_id=eq.${encodeURIComponent(uid)}&select=data`);
  const d = rows[0]?.data;
  if (!d || !Array.isArray(d.tables)) return DEFAULT_SETTINGS;
  return {
    folders: Array.isArray(d.folders) ? d.folders : DEFAULT_SETTINGS.folders,
    tables: d.tables,
    labels: { ...DEFAULT_SETTINGS.labels, ...(d.labels ?? {}) },
  };
}

/** 置き場の名前（例：自分の資料 / セミナー資料）。X の月の表は設定に無くても名前を作る */
function placeOf(cfg: Settings, tid: string | null): string {
  if (!tid) return "未整理";
  const t = cfg.tables.find(x => x.id === tid);
  if (!t) {
    const m = X_MONTH.exec(tid);
    return m ? `Xポスト / ${m[1]}年 / ${+m[2]}月` : "未整理";
  }
  const path: string[] = [];
  let f = cfg.folders.find(x => x.id === t.folder);
  while (f) { path.unshift(f.name); f = f.parent ? cfg.folders.find(x => x.id === f!.parent) : undefined; }
  return [...path, t.name].join(" / ");
}

function stageOf(row: Pick<Swipe, "reason" | "an_hypo" | "an_idea">): string {
  const n = [row.reason, row.an_hypo, row.an_idea].filter(v => (v ?? "").trim()).length;
  return STAGES[n];
}

function toOut(cfg: Settings, row: Swipe, full: boolean): SwipeOut {
  const body = row.body ?? "";
  const cut = !full && body.length > BODY_PREVIEW_CHARS;
  const props = (row.props ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    title: row.title,
    place: placeOf(cfg, row.table_id),
    table_id: row.table_id,
    shu: row.shu,
    refs: row.refs ?? [],
    grade: GRADE_LETTER[row.grade ?? 0] ?? "",
    genres: row.genres ?? [],
    labels: row.labels ?? [],
    stage: stageOf(row),
    analysis: { why: row.reason ?? "", hypo: row.an_hypo ?? "", idea: row.an_idea ?? "" },
    ai_ask: !!row.ai_ask,
    url: row.source_url,
    author: row.author,
    excerpt: row.excerpt,
    body: body ? (cut ? `${body.slice(0, BODY_PREVIEW_CHARS)}…` : body) : null,
    body_chars: body.length,
    body_truncated: cut,
    file_url: row.file_url,
    image_url: (props.shot as string) || null,
    highlights: row.highlights ?? [],
    used_log: row.used_log ?? [],
    fields: (props.ex as Record<string, unknown>) ?? {},
    source_type: row.source_type,
    ref_count: row.ref_count,
    created_at: row.created_at,
  };
}

/* ── 選べる値の検査（AI は決まった値の中からだけ選ぶ） ─────────────────── */

interface Allowed { shu: Set<string>; ref: Set<string>; genre: Set<string>; tag: Set<string>; tables: Set<string> }

async function allowedValues(env: Env, cfg: Settings): Promise<Allowed> {
  const uid = currentUserId(env);
  const rows = await selectRows<Pick<Swipe, "shu" | "refs" | "genres" | "labels" | "table_id">>(
    env, `${TABLE}?user_id=eq.${encodeURIComponent(uid)}&select=shu,refs,genres,labels,table_id`,
  );
  const s = (base: string[], extra: Array<string | null | undefined>) => new Set([...base, ...extra.filter((v): v is string => !!v)]);
  return {
    shu: s(cfg.labels.shu, rows.map(r => r.shu)),
    ref: s(cfg.labels.ref, rows.flatMap(r => r.refs ?? [])),
    genre: s(cfg.labels.genre, rows.flatMap(r => r.genres ?? [])),
    tag: s(cfg.labels.tag, rows.flatMap(r => r.labels ?? [])),
    tables: new Set(cfg.tables.map(t => t.id)),
  };
}

function check(kind: string, values: string[] | undefined, allowed: Set<string>): void {
  if (!values) return;
  const bad = values.filter(v => !allowed.has(v));
  if (bad.length) {
    throw new Error(`label_not_allowed: ${kind} に無い値です（${bad.join("・")}）。選べる値：${[...allowed].join("・")}。増やすときは Naoki が画面の「＋」で足す`);
  }
}

function checkTable(tid: string | undefined | null, allowed: Allowed): void {
  if (tid === undefined || tid === null || tid === "") return;
  if (allowed.tables.has(tid) || X_MONTH.test(tid)) return;
  throw new Error(`table_not_found: 置き場 ${tid} はありません。swipe__list_tags の tables から選ぶ（X のポストは x-YYYY-MM でもよい）`);
}

const GRADE_FROM: Record<string, number> = { S: 5, A: 4, B: 3, C: 2, D: 1, "": 0 };

/* ── 登録 ───────────────────────────────────────────────────────────────── */

export interface AddInput {
  title?: string;
  reason?: string;
  url?: string;
  body?: string;
  table?: string;
  shu?: string;
  refs?: string[];
  grade?: "S" | "A" | "B" | "C" | "D";
  genres?: string[];
  labels?: string[];
  hypo?: string;
  idea?: string;
  ai_ask?: boolean;
  source_type?: string;
  author?: string;
  excerpt?: string;
  visibility?: string;
  topic_tags?: string[];
  content_axis?: string;
}

async function fetchPageMeta(env: Env, url: string): Promise<{ title: string; description: string }> {
  const base = (env.SWIPE_APP_BASE ?? "").replace(/\/$/, "");
  if (!base || !/^https?:\/\//i.test(url)) return { title: "", description: "" };
  try {
    const res = await fetch(`${base}/api/ogp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }), signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { title: "", description: "" };
    const data = (await res.json()) as { fetched?: boolean; title?: string | null; description?: string | null };
    if (!data?.fetched) return { title: "", description: "" };
    return { title: data.title ?? "", description: data.description ?? "" };
  } catch {
    return { title: "", description: "" };
  }
}

/** X のリンク先の情報から、投稿者・アカウント・ポストの本文を取り出す（画面の fromXCard と同じ規則） */
export function fromXCard(page: { title: string; description: string }, url = ""): { author: string; handle: string; text: string } {
  const out = { author: "", handle: "", text: "" };
  const m = /(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status/i.exec(url);
  if (m) out.handle = "@" + m[1];
  const title = String(page.title || "").trim();
  let r: RegExpExecArray | null;
  if ((r = /^(.*?)\s*\(@([A-Za-z0-9_]+)\)\s+on (X|Twitter)$/.exec(title))) out.author = r[1];
  else if ((r = /^(.*?) on (X|Twitter): [“"]([\s\S]*)[”"]\s*\/\s*(X|Twitter)$/.exec(title))) { out.author = r[1]; out.text = r[3]; }
  if (!out.text) out.text = String(page.description || "").trim();
  return out;
}

function jstMonthTable(d = new Date()): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(d);
  return `x-${f.slice(0, 7)}`;
}

function shuFromSource(src: string): string | null {
  if (src === "X") return "ポスト";
  if (src === "note" || src === "ブログ" || src === "ノート") return "記事";
  if (src === "PDF" || src === "YouTube") return "教材";
  return null;
}

export interface AddResult { swipe: SwipeOut; ai_enriched: boolean }

export async function addSwipe(env: Env, input: AddInput, ctx?: { cfg: Settings; allowed: Allowed }): Promise<AddResult> {
  const url = (input.url ?? "").trim();
  const body = (input.body ?? "").trim();
  if (!url && !body) throw new Error("substance_required: url か body のどちらかが必要です");

  const cfg = ctx?.cfg ?? await loadSettings(env);
  const allowed = ctx?.allowed ?? await allowedValues(env, cfg);
  check("種類（shu）", input.shu ? [input.shu] : undefined, allowed.shu);
  check("参考ポイント（refs）", input.refs, allowed.ref);
  check("ジャンル（genres）", input.genres, allowed.genre);
  check("ラベル（labels）", input.labels, allowed.tag);
  checkTable(input.table, allowed);

  const needsEnrich = !input.title || !input.excerpt || !input.source_type;
  const ai = needsEnrich ? await enrich(env, { url, body, reason: input.reason ?? "" }) : {};
  const aiWorked = Object.values(ai).some(v => v !== undefined);
  let page = url ? await fetchPageMeta(env, url) : { title: "", description: "" };
  const src = input.source_type ?? ai.source_type ?? detectSourceType(url, body.length > 0);
  // X の題名は「名前 (@id) on X」でポストの中身ではない。本文は説明文の側にある（画面の src/engine/data.js と同じ規則）
  const x = src === "X" ? fromXCard(page, url) : null;
  if (x) page = { title: "", description: "" };
  const text = body || x?.text || "";
  const titled = deriveTitle({ manualTitle: input.title ?? "", pageTitle: page.title, aiTitle: ai.title, body: text });
  const excerpt = deriveExcerpt({ manualExcerpt: input.excerpt, aiExcerpt: ai.excerpt, pageDescription: page.description, body: text });

  // 置き場の自動：X は今月の表、note は記事、ほかは未整理（画面の「足す」と同じ規則）
  let table = input.table || null;
  if (!table) {
    if (src === "X") table = jstMonthTable();
    else if (src === "note" && allowed.tables.has("t-note")) table = "t-note";
  }

  const row = {
    user_id: currentUserId(env),
    source_url: url || null,
    body: text || null,
    reason: (input.reason ?? "").trim(),
    title: titled.title,
    title_auto: titled.auto,
    topic_tags: input.topic_tags ?? [],
    source_type: src,
    author: input.author ?? (x?.author || null) ?? ai.author ?? null,
    excerpt: excerpt || null,
    content_axis: input.content_axis ?? null,
    visibility: input.visibility ?? "private",
    status: "未活用",
    table_id: table,
    shu: input.shu ?? shuFromSource(src),
    refs: input.refs ?? [],
    grade: GRADE_FROM[input.grade ?? ""] ?? 0,
    genres: input.genres ?? [],
    labels: input.labels ?? [],
    an_hypo: (input.hypo ?? "").trim(),
    an_idea: (input.idea ?? "").trim(),
    ai_ask: input.ai_ask ?? false,
    props: x?.handle ? { handle: x.handle } : {},
  };
  const swipe = await insertRow<Swipe>(env, TABLE, row);
  return { swipe: toOut(cfg, swipe, true), ai_enriched: aiWorked };
}

export async function addContext(env: Env): Promise<{ cfg: Settings; allowed: Allowed }> {
  const cfg = await loadSettings(env);
  return { cfg, allowed: await allowedValues(env, cfg) };
}

/* ── 検索（参照回数は増やさない） ─────────────────────────────────────── */

export interface SearchInput {
  keyword?: string;
  shu?: string;
  ref?: string;
  grade_min?: "S" | "A" | "B" | "C" | "D";
  genre?: string;
  label?: string;
  stage?: (typeof STAGES)[number];
  ai_ask?: boolean;
  table?: string;
  source_type?: string;
  status?: string;
  tags?: string[];
  sort?: "created" | "ref";
  limit?: number;
}

function safeKeyword(kw: string): string {
  return kw.replace(/[,()%*\\"']/g, " ").trim();
}
const arr = (v: string) => encodeURIComponent(`{"${v.replace(/"/g, "")}"}`);

export async function searchSwipes(env: Env, input: SearchInput): Promise<SwipeOut[]> {
  const uid = currentUserId(env);
  const params: string[] = [`user_id=eq.${encodeURIComponent(uid)}`, "select=*"];
  const kw = safeKeyword(input.keyword ?? "");
  if (kw) {
    const like = `*${kw}*`;
    params.push(`or=${encodeURIComponent(`(title.ilike.${like},reason.ilike.${like},an_hypo.ilike.${like},an_idea.ilike.${like},body.ilike.${like},excerpt.ilike.${like},author.ilike.${like})`)}`);
  }
  if (input.shu) params.push(`shu=eq.${encodeURIComponent(input.shu)}`);
  if (input.ref) params.push(`refs=cs.${arr(input.ref)}`);
  if (input.genre) params.push(`genres=cs.${arr(input.genre)}`);
  if (input.label) params.push(`labels=cs.${arr(input.label)}`);
  if (input.grade_min) params.push(`grade=gte.${GRADE_FROM[input.grade_min]}`);
  if (input.ai_ask !== undefined) params.push(`ai_ask=eq.${input.ai_ask}`);
  if (input.table) params.push(input.table === "unsorted" ? "table_id=is.null" : `table_id=eq.${encodeURIComponent(input.table)}`);
  if (input.source_type) params.push(`source_type=eq.${encodeURIComponent(input.source_type)}`);
  if (input.status) params.push(`status=eq.${encodeURIComponent(input.status)}`);
  if (input.tags?.length) params.push(`topic_tags=cs.${encodeURIComponent(`{${input.tags.join(",")}}`)}`);
  params.push(input.sort === "ref" ? "order=ref_count.desc,created_at.desc" : "order=created_at.desc");
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  // 分析の段は 3 つの欄から決まるため、ここでは多めに取ってから絞る
  params.push(`limit=${input.stage ? 1000 : limit}`);

  const [rows, cfg] = await Promise.all([selectRows<Swipe>(env, `${TABLE}?${params.join("&")}`), loadSettings(env)]);
  const picked = input.stage ? rows.filter(r => stageOf(r) === input.stage).slice(0, limit) : rows;
  return picked.map(r => toOut(cfg, r, false));
}

/* ── 1件取得（呼び出しのたびに +1） ──────────────────────────────────── */

export async function getSwipe(env: Env, id: string): Promise<SwipeOut> {
  await callRpc(env, "sw_increment_ref", { p_id: id, p_user_id: currentUserId(env) });
  const [row, cfg] = await Promise.all([fetchWithoutCounting(env, id), loadSettings(env)]);
  return toOut(cfg, row, true);
}

export async function fetchWithoutCounting(env: Env, id: string): Promise<Swipe> {
  const uid = currentUserId(env);
  const rows = await selectRows<Swipe>(env, `${TABLE}?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(uid)}&select=*`);
  if (!rows.length) throw new Error(`not_found: id=${id}`);
  return rows[0];
}

/* ── 部分更新 ─────────────────────────────────────────────────────────── */

export interface UpdateInput {
  id: string;
  title?: string;
  reason?: string;
  hypo?: string;
  idea?: string;
  url?: string;
  body?: string;
  table?: string;
  shu?: string;
  refs?: string[];
  grade?: "S" | "A" | "B" | "C" | "D" | "";
  genres?: string[];
  labels?: string[];
  ai_ask?: boolean;
  author?: string;
  excerpt?: string;
  visibility?: string;
}

export async function updateSwipe(env: Env, input: UpdateInput): Promise<SwipeOut> {
  const cfg = await loadSettings(env);
  const allowed = await allowedValues(env, cfg);
  check("種類（shu）", input.shu ? [input.shu] : undefined, allowed.shu);
  check("参考ポイント（refs）", input.refs, allowed.ref);
  check("ジャンル（genres）", input.genres, allowed.genre);
  check("ラベル（labels）", input.labels, allowed.tag);
  checkTable(input.table, allowed);

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) {
    if (!input.title.trim()) throw new Error("title_required: 見出しを空にはできません");
    patch.title = input.title.trim(); patch.title_auto = false;
  }
  if (input.reason !== undefined) patch.reason = input.reason.trim();
  if (input.hypo !== undefined) patch.an_hypo = input.hypo.trim();
  if (input.idea !== undefined) patch.an_idea = input.idea.trim();
  if (input.url !== undefined) patch.source_url = input.url.trim() || null;
  if (input.body !== undefined) patch.body = input.body.trim() || null;
  if (input.table !== undefined) patch.table_id = input.table || null;
  if (input.shu !== undefined) patch.shu = input.shu || null;
  if (input.refs !== undefined) patch.refs = input.refs;
  if (input.grade !== undefined) patch.grade = GRADE_FROM[input.grade] ?? 0;
  if (input.genres !== undefined) patch.genres = input.genres;
  if (input.labels !== undefined) patch.labels = input.labels;
  if (input.ai_ask !== undefined) patch.ai_ask = input.ai_ask;
  if (input.author !== undefined) patch.author = input.author || null;
  if (input.excerpt !== undefined) patch.excerpt = input.excerpt || null;
  if (input.visibility !== undefined) patch.visibility = input.visibility;
  if (!Object.keys(patch).length) throw new Error("no_fields: 更新する項目が指定されていません");

  if ("source_url" in patch || "body" in patch) {
    const cur = await fetchWithoutCounting(env, input.id);
    const url = "source_url" in patch ? (patch.source_url as string | null) : cur.source_url;
    const body = "body" in patch ? (patch.body as string | null) : cur.body;
    if (!(url ?? "").trim() && !(body ?? "").trim() && !(cur.file_url ?? "").trim()) {
      throw new Error("substance_required: url / body / file_url がすべて空になる更新はできません");
    }
  }
  return toOut(cfg, await updateRow<Swipe>(env, TABLE, input.id, patch), true);
}

/* ── Claude の分析の下書き（空いている段だけ埋める） ────────────────────── */

export interface DraftInput {
  id: string;
  why?: string;
  hypo?: string;
  idea?: string;
  refs?: string[];
  genres?: string[];
}

export async function fillAnalysis(env: Env, input: DraftInput): Promise<{ swipe: SwipeOut; filled: string[]; kept: string[] }> {
  const cfg = await loadSettings(env);
  const allowed = await allowedValues(env, cfg);
  check("参考ポイント（refs）", input.refs, allowed.ref);
  check("ジャンル（genres）", input.genres, allowed.genre);
  const cur = await fetchWithoutCounting(env, input.id);
  const patch: Record<string, unknown> = { ai_ask: false };
  const filled: string[] = [], kept: string[] = [];
  const step = (col: "reason" | "an_hypo" | "an_idea", label: string, v?: string) => {
    if (v === undefined || !v.trim()) return;
    if ((cur[col] ?? "").trim()) { kept.push(label); return; }
    patch[col] = v.trim(); filled.push(label);
  };
  step("reason", "言語化", input.why);
  step("an_hypo", "仮説", input.hypo);
  step("an_idea", "用途抽出", input.idea);
  if (input.refs?.length) { if ((cur.refs ?? []).length) kept.push("参考ポイント"); else { patch.refs = input.refs; filled.push("参考ポイント"); } }
  if (input.genres?.length) { if ((cur.genres ?? []).length) kept.push("ジャンル"); else { patch.genres = input.genres; filled.push("ジャンル"); } }
  const row = await updateRow<Swipe>(env, TABLE, input.id, patch);
  return { swipe: toOut(cfg, row, false), filled, kept };
}

/* ── 使った記録 ───────────────────────────────────────────────────────── */

export async function markUsed(env: Env, id: string, usedIn?: string): Promise<SwipeOut> {
  const [cur, cfg] = await Promise.all([fetchWithoutCounting(env, id), loadSettings(env)]);
  const patch: Record<string, unknown> = { status: "活用済" };
  if (usedIn && usedIn.trim()) {
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
    patch.used_log = [{ w: usedIn.trim(), d }, ...(cur.used_log ?? [])];
    patch.used_in = usedIn.trim();
  }
  return toOut(cfg, await updateRow<Swipe>(env, TABLE, id, patch), false);
}

/* ── 選べる値と置き場の一覧 ───────────────────────────────────────────── */

export async function listVocabulary(env: Env) {
  const uid = currentUserId(env);
  const [cfg, rows] = await Promise.all([
    loadSettings(env),
    selectRows<Pick<Swipe, "shu" | "refs" | "genres" | "labels" | "table_id" | "topic_tags">>(
      env, `${TABLE}?user_id=eq.${encodeURIComponent(uid)}&select=shu,refs,genres,labels,table_id,topic_tags`,
    ),
  ]);
  const count = (base: string[], vals: string[]) => {
    const m = new Map<string, number>(base.map(v => [v, 0]));
    for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m.entries()].map(([value, n]) => ({ value, count: n }));
  };
  const tableIds = [...new Set([...cfg.tables.map(t => t.id), ...rows.map(r => r.table_id).filter((v): v is string => !!v)])];
  return {
    labels: {
      shu: count(cfg.labels.shu, rows.map(r => r.shu).filter((v): v is string => !!v)),
      refs: count(cfg.labels.ref, rows.flatMap(r => r.refs ?? [])),
      genres: count(cfg.labels.genre, rows.flatMap(r => r.genres ?? [])),
      labels: count(cfg.labels.tag, rows.flatMap(r => r.labels ?? [])),
    },
    stages: STAGES,
    grades: ["S", "A", "B", "C", "D"],
    tables: [
      ...tableIds.map(id => ({ id, place: placeOf(cfg, id), count: rows.filter(r => r.table_id === id).length })),
      { id: "unsorted", place: "未整理", count: rows.filter(r => !r.table_id).length },
    ],
    old_topic_tags: count([], rows.flatMap(r => r.topic_tags ?? [])),
  };
}
