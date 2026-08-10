import type { Env } from "./index.js";
import { ORPHANS, selectRows, currentUserId } from "./supabase-client.js";

/**
 * Zeus 索引の掃除（要件 v1.7 §F6 の後始末）。
 *
 * スワイプを削除するとき、画面側は索引ID（zeus_item_id）を sw_zeus_orphans へ
 * 退避してから本体を消す。この置き場に溜まったIDを Zeus の削除の口へ渡し、
 * 索引を消してから置き場の行も片づける。
 *
 * 設計の要点：
 *   1. Zeus 側は「すでに消えているID」をエラーにせず not_found で返す。
 *      索引が無いこと自体が目的の状態なので、not_found も片づけの対象に含める。
 *   2. Zeus 側で消えたことを確かめてから置き場の行を消す。順序を逆にすると、
 *      置き場だけ空になって Zeus に消せない索引が残る。
 *   3. 失敗した分は置き場に残す。もう一度呼べば続きから片づく。
 *   4. Zeus へ渡す利用者の印は、登録のときと同じもの（zeus.ts の pushToZeus と同一）。
 */

const ZEUS_DELETE_URL = "https://zeus.shia2n.jp/api/external/delete-from-zeus";

// Zeus 側と同じ区切り。1回の呼び出しに載せるIDの数。
const CHUNK = 50;

interface OrphanRow {
  id: string;
  zeus_item_id: string;
}

export interface ZeusCleanupResult {
  ok: boolean;
  対象: number;
  索引を消した: number;
  もともと無かった: number;
  置き場から外した: number;
  残した: number;
  下見のみ: boolean;
  詳細?: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 置き場の行を消す。supabase-client には削除の口が無いため、
 * zeus.ts の書き戻しと同じ形（直接 REST を呼ぶ）に揃えている。
 */
async function removeOrphanRows(env: Env, rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return;
  const url = `${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/${ORPHANS}` +
    `?user_id=eq.${encodeURIComponent(currentUserId(env))}` +
    `&id=in.(${rowIds.join(",")})`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      apikey:        env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`置き場の片づけに失敗しました：${res.status} ${text.slice(0, 200)}`);
  }
}

export async function cleanupZeusOrphans(
  env: Env,
  opts: { limit?: number; dry_run?: boolean } = {}
): Promise<ZeusCleanupResult> {
  const limit  = opts.limit ?? 100;
  const dryRun = opts.dry_run === true;

  if (!env.ZEUS_EXTERNAL_SECRET) {
    return {
      ok: false, 対象: 0, 索引を消した: 0, もともと無かった: 0,
      置き場から外した: 0, 残した: 0, 下見のみ: dryRun,
      詳細: "Zeus の合言葉（ZEUS_EXTERNAL_SECRET）が未設定です",
    };
  }

  const userId = currentUserId(env);

  // 古いものから片づける。途中で止まっても、次に呼べば続きから進む。
  const rows = await selectRows<OrphanRow>(
    env,
    `${ORPHANS}?user_id=eq.${encodeURIComponent(userId)}` +
      `&select=id,zeus_item_id&order=deleted_at.asc&limit=${limit}`
  );

  if (rows.length === 0) {
    return {
      ok: true, 対象: 0, 索引を消した: 0, もともと無かった: 0,
      置き場から外した: 0, 残した: 0, 下見のみ: dryRun,
      詳細: "掃除待ちはありません",
    };
  }

  if (dryRun) {
    return {
      ok: true, 対象: rows.length, 索引を消した: 0, もともと無かった: 0,
      置き場から外した: 0, 残した: rows.length, 下見のみ: true,
      詳細: "下見のみのため、何も消していません",
    };
  }

  // 同じ索引IDの行が複数あることがあるため、IDから行へ引けるようにしておく
  const rowsByItemId = new Map<string, string[]>();
  for (const r of rows) {
    const key  = String(r.zeus_item_id);
    const list = rowsByItemId.get(key) ?? [];
    list.push(r.id);
    rowsByItemId.set(key, list);
  }
  const itemIds = [...rowsByItemId.keys()];

  let 消した     = 0;
  let 無かった   = 0;
  let 外した     = 0;
  const 失敗理由: string[] = [];

  for (const ids of chunk(itemIds, CHUNK)) {
    let data: { deleted?: string[]; not_found?: string[]; invalid?: string[] };
    try {
      const res = await fetch(ZEUS_DELETE_URL, {
        method: "POST",
        headers: {
          Authorization:  `Bearer ${env.ZEUS_EXTERNAL_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user_id: userId, item_ids: ids }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        失敗理由.push(`${res.status} ${text.slice(0, 120)}`);
        continue; // 置き場の行はそのまま残す
      }
      data = (await res.json().catch(() => ({}))) as typeof data;
    } catch (err) {
      失敗理由.push(err instanceof Error ? err.message : String(err));
      continue;
    }

    const deleted   = data.deleted   ?? [];
    const not_found = data.not_found ?? [];
    const invalid   = data.invalid   ?? [];

    if (invalid.length > 0) {
      // 形が正しくないIDは Zeus 側で消せない。置き場に残して分かるようにする。
      失敗理由.push(`Zeus が受け付けない形のIDが ${invalid.length} 件ありました`);
    }

    消した   += deleted.length;
    無かった += not_found.length;

    // 索引が無くなったことを確かめてから、置き場の行を消す
    const 片づける = [...deleted, ...not_found].flatMap(
      itemId => rowsByItemId.get(String(itemId)) ?? []
    );
    try {
      await removeOrphanRows(env, 片づける);
      外した += 片づける.length;
    } catch (err) {
      失敗理由.push(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    ok: 失敗理由.length === 0,
    対象: rows.length,
    索引を消した: 消した,
    もともと無かった: 無かった,
    置き場から外した: 外した,
    残した: rows.length - 外した,
    下見のみ: false,
    詳細: 失敗理由.length ? 失敗理由.join(" / ") : undefined,
  };
}
