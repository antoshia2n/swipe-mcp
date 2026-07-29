import type { Env } from "./index.js";
import { TABLE, selectRows, currentUserId } from "./supabase-client.js";

/**
 * Zeus v2 索引への登録（要件 v1.7 §F5）。
 *
 * リトライ規則はアプリ側（/api/zeus-sync）と同一：
 *   索引IDあり → push しない（二重登録防止）
 *   索引IDなし → push し、返ってきたIDを保存してからフラグを立てる
 *
 * 失敗しても例外を投げない。登録そのものは成功させる。
 */

const ZEUS_PUSH_URL = "https://zeus.shia2n.jp/api/external/push-to-zeus";

export interface ZeusSyncResult {
  status: "pushed" | "skipped" | "failed";
  zeus_item_id?: string;
  reason?: string;
}

export async function pushToZeus(
  env: Env,
  swipe: { id: string; title: string; reason: string; topic_tags: string[]; zeus_item_id: string | null }
): Promise<ZeusSyncResult> {
  if (!env.ZEUS_EXTERNAL_SECRET) {
    return { status: "skipped", reason: "ZEUS_EXTERNAL_SECRET が未設定です" };
  }
  if (swipe.zeus_item_id) {
    return { status: "skipped", reason: "すでに索引登録済みです" };
  }

  const base      = (env.SWIPE_APP_BASE || "https://swipe.shia2n.jp").replace(/\/+$/, "");
  const detailUrl = `${base}/?id=${swipe.id}`;
  const content   = [
    swipe.reason,
    swipe.topic_tags?.length ? `タグ：${swipe.topic_tags.join(" / ")}` : null,
    `スワイプファイルで開く：${detailUrl}`,
  ].filter(Boolean).join("\n");

  let res: Response;
  try {
    res = await fetch(ZEUS_PUSH_URL, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${env.ZEUS_EXTERNAL_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id:    currentUserId(env),
        source_app: "swipe-file",
        title:      swipe.title || swipe.reason,
        content,
        source_url: detailUrl,
      }),
    });
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { status: "failed", reason: `${res.status} ${text.slice(0, 120)}` };
  }

  const data   = (await res.json().catch(() => ({}))) as { item_id?: string };
  const itemId = data.item_id;
  if (!itemId) return { status: "failed", reason: "Zeus から索引IDが返りませんでした" };

  // 索引IDを保存してからフラグを立てる（途中で落ちても二重登録にならない順序）
  await selectRows(env, `${TABLE}?id=eq.${swipe.id}&select=id`); // 接続確認を兼ねる
  const patchRes = await fetch(
    `${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/${TABLE}?id=eq.${swipe.id}`,
    {
      method:  "PATCH",
      headers: {
        apikey:         env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization:  `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ zeus_item_id: itemId, zeus_synced: true }),
    }
  );
  if (!patchRes.ok) {
    return { status: "failed", reason: "索引は作られましたが保存に失敗しました（次回リトライで復旧します）" };
  }

  return { status: "pushed", zeus_item_id: itemId };
}
