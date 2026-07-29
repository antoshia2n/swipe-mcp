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
