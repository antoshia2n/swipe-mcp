import type { Env } from "./index.js";

/**
 * GET /diag — swipe-mcp の自己診断（認証不要・秘密情報は返さない）
 * デバッグ鉄則：Naoki はブラウザで URL を1つ開くだけで原因が分かる状態にする。
 */
export async function handleDiag(_request: Request, env: Env): Promise<Response> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const required: Array<[string, string | undefined]> = [
    ["MCP_SERVER_SECRET", env.MCP_SERVER_SECRET],
    ["MCP_DEFAULT_USER_ID", env.MCP_DEFAULT_USER_ID],
    ["SUPABASE_URL", env.SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", env.SUPABASE_SERVICE_ROLE_KEY],
    ["ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY],
    ["ZEUS_EXTERNAL_SECRET", env.ZEUS_EXTERNAL_SECRET],
  ];
  for (const [name, value] of required) {
    checks.push({
      name: `Secret ${name}`,
      ok: typeof value === "string" && value.length > 0,
      detail: value ? "設定済み" : "未設定。Workers の Variables and Secrets に追加してください",
    });
  }

  // Supabase 接続とテーブルの列（v1.7 の列まで指定して取りこぼしも検出する）
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const url = `${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/sw_swipes?select=id,body,file_url,visibility,ref_count&limit=1`;
    try {
      const res = await fetch(url, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (res.ok) {
        checks.push({ name: "Supabase sw_swipes", ok: true, detail: "接続成功・列も最新" });
      } else {
        const text = await res.text().catch(() => "");
        checks.push({
          name: "Supabase sw_swipes",
          ok: false,
          detail: /column .* does not exist/i.test(text)
            ? "テーブルはありますが列が古い版です。03_v17_columns.sql を実行してください"
            : `${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
        });
      }
    } catch (err) {
      checks.push({
        name: "Supabase sw_swipes",
        ok: false,
        detail: `接続できません：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 掃除待ちの置き場（sw_zeus_orphans）。掃除の道具が読む先なので、
  // 接続と、画面側が書き込もうとしている列の有無を分けて出す。
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const base = env.SUPABASE_URL.replace(/\/+$/, "");
    const head = {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    };

    try {
      const res = await fetch(
        `${base}/rest/v1/sw_zeus_orphans?select=id,zeus_item_id,source_url&limit=1`,
        { headers: head }
      );
      checks.push({
        name: "Supabase sw_zeus_orphans",
        ok: res.ok,
        detail: res.ok
          ? "接続成功"
          : `${res.status} ${res.statusText} — ${(await res.text().catch(() => "")).slice(0, 200)}`,
      });
    } catch (err) {
      checks.push({
        name: "Supabase sw_zeus_orphans",
        ok: false,
        detail: `接続できません：${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 画面側の削除処理は退避のときに title も書き込む。
    // 列が無いと退避が失敗し、スワイプの削除そのものが中止になる。
    try {
      const res = await fetch(
        `${base}/rest/v1/sw_zeus_orphans?select=title&limit=1`,
        { headers: head }
      );
      const text = res.ok ? "" : await res.text().catch(() => "");
      checks.push({
        name: "退避の表の title 列",
        ok: res.ok,
        detail: res.ok
          ? "あり"
          : /column .* does not exist/i.test(text)
            ? "無し。画面側の削除は退避の書き込みで失敗し、スワイプを消せない状態です"
            : `${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
      });
    } catch (err) {
      checks.push({
        name: "退避の表の title 列",
        ok: false,
        detail: `確認できません：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Zeus の索引削除の口。掃除の道具が呼ぶ先。
  // 認証の要らない生存確認だけを行い、削除は実行しない。
  try {
    const res = await fetch("https://zeus.shia2n.jp/api/external/delete-from-zeus", {
      method: "GET",
    });
    const text = await res.text().catch(() => "");
    checks.push({
      name: "Zeus の索引削除の口",
      ok: res.ok && text.includes("索引の削除"),
      detail: res.ok && text.includes("索引の削除")
        ? "つながっています"
        : `見つかりません（応答コード ${res.status}）。Zeus 側の反映を確認してください`,
    });
  } catch (err) {
    checks.push({
      name: "Zeus の索引削除の口",
      ok: false,
      detail: `つながりません：${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const ng = checks.filter((c) => !c.ok).length;
  return Response.json(
    {
      app: "swipe-mcp",
      version: "1.0.0",
      checked_at: new Date().toISOString(),
      summary: { total: checks.length, ok: checks.length - ng, ng },
      checks,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
