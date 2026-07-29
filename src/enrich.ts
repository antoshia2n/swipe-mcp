import type { Env } from "./index.js";
import { listTagCounts } from "./swipe-store.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL             = "claude-haiku-4-5-20251001";
const EXCERPT_MAX       = 200;

export const CONTENT_AXES = ["思考系", "習慣系", "攻略系", "その他"] as const;
export const SOURCE_TYPES = ["X", "note", "YouTube", "ブログ", "ノート", "PDF", "その他"] as const;

export interface EnrichResult {
  title?: string;
  topic_tags?: string[];
  author?: string;
  excerpt?: string;
  content_axis?: string;
  source_type?: string;
}

/** URL から媒体を推定する（要件 v1.7 §4.1） */
export function detectSourceType(url = "", hasBody = false): string {
  const u = url.toLowerCase();
  if (/(^|\/\/)(www\.)?(x\.com|twitter\.com)\//.test(u)) return "X";
  if (/(^|\/\/)(www\.)?note\.com\//.test(u))             return "note";
  if (/youtube\.com|youtu\.be/.test(u))                  return "YouTube";
  if (/^https?:\/\//.test(u))                            return "ブログ";
  if (hasBody)                                           return "ノート";
  return "その他";
}

/**
 * 省略された項目を AI で補う（要件 v1.7 §5 F1 / §F4 swipe__add）。
 *
 * 順序厳守：タグを提案させる前に既存タグ一覧を渡し、意味が近ければ
 * 新語を作らず既存の表記へ寄せる（表記ゆれの発生源を断つ・受け入れ基準10）。
 *
 * 失敗しても例外にしない。空の結果を返し、登録自体は通す。
 */
export async function enrich(
  env: Env,
  input: { url?: string; body?: string; reason: string }
): Promise<EnrichResult> {
  if (!env.ANTHROPIC_API_KEY) return {};

  let existingTags: string[] = [];
  try {
    existingTags = (await listTagCounts(env)).slice(0, 60).map(t => t.tag);
  } catch {
    // 取得できなくても補完は続ける
  }

  const tagGuide = existingTags.length
    ? `## すでに使われているタグ（意味の近いものがあれば、新しい言い方を作らずこの表記をそのまま使う）\n${existingTags.join(" / ")}`
    : "## すでに使われているタグ\n（まだありません。短く一般的な言い方を選んでください）";

  const system = `あなたはスワイプファイル（お手本・見本データの保管庫）の整理係です。
渡された情報から、保管に必要な項目を推定して JSON だけを返してください。

${tagGuide}

## 出力形式（コードブロックや前置きは不要）
{"title":"見出し","topic_tags":["タグ1","タグ2"],"author":"発信者名","excerpt":"短い抜粋","content_axis":"思考系","source_type":"X"}

## ルール
- title：内容が一目で分かる短い見出し（40文字以内）
- topic_tags：内容を表すキーワードを1〜3個。既存タグに意味が近いものがあれば必ずその表記をそのまま使う
- author：分かる場合のみ。不明なら空文字
- excerpt：一覧に出す短い抜粋。全角${EXCERPT_MAX}文字以内。分からなければ空文字。事実を創作しない
- content_axis：${CONTENT_AXES.join(" / ")} から1つ
- source_type：${SOURCE_TYPES.join(" / ")} から1つ（URLが無く本文だけならノート）
- 分からない項目は空文字にする`;

  const content = [
    input.url  ? `URL：${input.url}` : null,
    `保存したい理由：${input.reason}`,
    input.body ? `本文：\n${input.body.slice(0, 6000)}` : null,
  ].filter(Boolean).join("\n");

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method:  "POST",
      headers: {
        "x-api-key":         env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type":      "application/json",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system, messages: [{ role: "user", content }] }),
    });
  } catch {
    return {};
  }
  if (!res.ok) return {};

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const raw  = data.content?.filter(c => c.type === "text").map(c => c.text ?? "").join("") ?? "";

  let parsed: EnrichResult;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as EnrichResult;
  } catch {
    return {};
  }

  return {
    title:        parsed.title || undefined,
    topic_tags:   Array.isArray(parsed.topic_tags) ? parsed.topic_tags.slice(0, 5) : undefined,
    author:       parsed.author || undefined,
    excerpt:      parsed.excerpt ? String(parsed.excerpt).slice(0, EXCERPT_MAX) : undefined,
    content_axis: (CONTENT_AXES as readonly string[]).includes(parsed.content_axis ?? "") ? parsed.content_axis : undefined,
    source_type:  (SOURCE_TYPES as readonly string[]).includes(parsed.source_type ?? "") ? parsed.source_type : undefined,
  };
}
