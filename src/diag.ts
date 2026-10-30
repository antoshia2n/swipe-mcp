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
    const url = `${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/sw_swipes?select=id,body,file_url,ref_count,table_id,shu,refs,grade,genres,labels,an_hypo,an_idea,highlights,used_log,props,ai_ask&limit=1`;
    try {
      const res = await fetch(url, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}),
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
            ? "表はありますが列が古い版です。作業 25（スワイプくんの列を足す SQL）が済んでいません"
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

  // 設定の表（フォルダ・表・選べる値）。無くても既定の値で動くが、画面が書く先なので有無を出す
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const base = env.SUPABASE_URL.replace(/\/+$/, "");
    try {
      const res = await fetch(`${base}/rest/v1/sw_settings?select=user_id,data&limit=1`, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}),
        },
      });
      const text = res.ok ? "" : await res.text().catch(() => "");
      checks.push({ name: "Supabase sw_settings", ok: res.ok, detail: res.ok ? "接続成功" : `${res.status} — ${text.slice(0, 200)}` });
    } catch (err) {
      checks.push({ name: "Supabase sw_settings", ok: false, detail: `接続できません：${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // AI 補完の鍵は任意（無ければ見出しは題名・本文から付ける）
  checks.push({ name: "AI 補完（任意）", ok: true, detail: env.ANTHROPIC_API_KEY ? "鍵あり" : "鍵なし。見出しは題名・本文から付ける" });

  const ng = checks.filter((c) => !c.ok).length;
  return Response.json(
    {
      app: "swipe-mcp",
      version: "1.3.0-trace",
      checked_at: new Date().toISOString(),
      summary: { total: checks.length, ok: checks.length - ng, ng },
      checks,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
