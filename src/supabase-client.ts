import type { Env } from "./index.js";

/**
 * Supabase REST（PostgREST）を叩く薄い層。
 * user_id は常に MCP_DEFAULT_USER_ID（Naoki 固定）を使う。
 * 要件 v1.7 の対象は単一ユーザーのため、他ユーザーの指定は受け付けない。
 */

export const TABLE   = "sw_swipes";
export const ORPHANS = "sw_zeus_orphans";

function requireConfig(env: Env): { url: string; key: string; userId: string } {
  if (!env.SUPABASE_URL)              throw new Error("SUPABASE_URL is not configured");
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  if (!env.MCP_DEFAULT_USER_ID)       throw new Error("MCP_DEFAULT_USER_ID is not configured");
  return {
    url:    env.SUPABASE_URL.replace(/\/+$/, ""),
    key:    env.SUPABASE_SERVICE_ROLE_KEY,
    userId: env.MCP_DEFAULT_USER_ID,
  };
}

export function currentUserId(env: Env): string {
  return requireConfig(env).userId;
}

async function request<T>(
  env: Env,
  path: string,
  init: RequestInit & { prefer?: string } = {}
): Promise<T> {
  const { url, key } = requireConfig(env);
  const headers: Record<string, string> = {
    apikey:         key,
    Authorization:  `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (init.prefer) headers.Prefer = init.prefer;

  let res: Response;
  try {
    res = await fetch(`${url}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`supabase_network_error: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`supabase_error: ${res.status} ${res.statusText} — ${text.slice(0, 400)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function selectRows<T>(env: Env, query: string): Promise<T[]> {
  return request<T[]>(env, `/rest/v1/${query}`, { method: "GET" });
}

export async function insertRow<T>(env: Env, table: string, row: Record<string, unknown>): Promise<T> {
  const rows = await request<T[]>(env, `/rest/v1/${table}`, {
    method: "POST",
    body:   JSON.stringify(row),
    prefer: "return=representation",
  });
  return rows[0];
}

export async function updateRow<T>(env: Env, table: string, id: string, patch: Record<string, unknown>): Promise<T> {
  const { userId } = requireConfig(env);
  const rows = await request<T[]>(
    env,
    `/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`,
    { method: "PATCH", body: JSON.stringify(patch), prefer: "return=representation" }
  );
  if (!rows.length) throw new Error(`not_found: id=${id}`);
  return rows[0];
}

export async function callRpc<T>(env: Env, fn: string, args: Record<string, unknown>): Promise<T> {
  return request<T>(env, `/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
}
