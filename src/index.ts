/**
 * swipe-mcp エントリーポイント v1.0.0
 *
 * スワイプファイルアプリ（お手本・見本データ）専用の MCP サーバー。
 * 要件定義 v1.7 §F4 に基づき、shia2n-mcp 本体とは完全に独立した Worker として動かす。
 *
 * ・shia2n-mcp 本体にツールを追加しない（本体は用途別分割を検討中のため）
 * ・パス分割方式は採用しない（動作トラブル中・2026-07-28 確認）
 * ・接続範囲はシアニン担当プロジェクトのみ
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { registerSwipeTools } from "./tools-swipe.js";
import { AuthHandler } from "./auth-handler.js";
import { handleDiag } from "./diag.js";

export interface Env {
  // MCP 接続
  MCP_SERVER_SECRET: string;
  MCP_DEFAULT_USER_ID: string;
  OAUTH_KV: KVNamespace;
  // Supabase（スワイプ本体の保管先）
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // AI 補完
  ANTHROPIC_API_KEY: string;
}

function createSwipeMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "swipe-mcp", version: "1.0.0" });
  registerSwipeTools(server, env);
  return server;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const server = createSwipeMcpServer(env);
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};

const oauthProvider = new OAuthProvider({
  apiRoute:   "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler: AuthHandler,
  authorizeEndpoint:          "/authorize",
  tokenEndpoint:              "/token",
  clientRegistrationEndpoint: "/register",
  resolveExternalToken: async ({ token, env: rawEnv }) => {
    const env = rawEnv as Env;
    if (!env.MCP_SERVER_SECRET) return null;
    if (!timingSafeEqual(token, env.MCP_SERVER_SECRET)) return null;
    return {
      userId: env.MCP_DEFAULT_USER_ID,
      props:  { userId: env.MCP_DEFAULT_USER_ID },
    };
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin":  "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
    }

    if (url.pathname === "/diag" && request.method === "GET") {
      return handleDiag(request, env);
    }

    return oauthProvider.fetch(request, env, ctx);
  },
};
