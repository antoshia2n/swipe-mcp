/**
 * 見出しと抜粋の決め方（唯一の規則）。
 *
 * ⚠️ このファイルは swipe-file リポジトリの src/lib/titling.js と対になっている。
 *    片方だけ直すと、画面から登録したときと AI から登録したときで見出しが変わる。
 *    規則を変えるときは必ず両方を同時に差し替えること。
 *
 * 決め方（上から順に見て、最初に取れたものを採用する）
 *   1. 人（呼び出し側）が指定した見出し
 *   2. リンク先のページ題名（アプリ側の /api/ogp から取る）
 *   3. AI が付けた見出し
 *   4. 本文の書き出し（記号と改行を掃除し、最初の文の区切りまで）
 *   5. ファイル名（拡張子を除く）
 *   6. 「見出し未設定」
 *
 * URL そのものは見出しにしない（何の素材か分からないため）。
 */

export const TITLE_UNSET = "見出し未設定";
export const TITLE_MAX   = 40;
export const TITLE_LIMIT = 120;
export const EXCERPT_MAX = 200;

/** 表示に使えるように掃除する（Markdown 記号・改行・連続空白を落とす） */
export function cleanText(raw = ""): string {
  return String(raw ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s{0,3}>+\s?/gm, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
    .replace(/^\s{0,3}[-*_]{3,}\s*$/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 文章から見出しを作る。最初の文の区切りまで、長ければ切る。 */
export function titleFromText(raw = "", max: number = TITLE_MAX): string {
  const clean = cleanText(raw);
  if (!clean) return "";

  const sentence = clean.match(/^[\s\S]*?[。！？!?]/);
  let head = (sentence ? sentence[0] : clean).replace(/[。！？!?]\s*$/, "").trim();
  if (head.length > max) head = `${head.slice(0, max)}…`;
  return head;
}

/** ファイル名から拡張子を落とす */
export function fileBaseName(name = ""): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  return base.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim();
}

/** 見出しが未設定（または空）かどうか */
export function isUnsetTitle(title?: string | null): boolean {
  const clean = cleanText(title ?? "");
  return !clean || clean === TITLE_UNSET;
}

export interface TitleInput {
  manualTitle?: string;
  pageTitle?:   string;
  aiTitle?:     string;
  body?:        string;
  fileName?:    string;
}

/** 見出しを決める。auto=true は自動で付けた見出し（あとで作り直せる） */
export function deriveTitle(input: TitleInput = {}): { title: string; auto: boolean } {
  const manual = cleanText(input.manualTitle ?? "");
  if (manual && manual !== TITLE_UNSET) {
    return { title: manual.slice(0, TITLE_LIMIT), auto: false };
  }

  const page = cleanText(input.pageTitle ?? "");
  if (page) return { title: page.slice(0, TITLE_LIMIT), auto: true };

  const ai = cleanText(input.aiTitle ?? "");
  if (ai) return { title: ai.slice(0, TITLE_LIMIT), auto: true };

  const fromBody = titleFromText(input.body ?? "");
  if (fromBody) return { title: fromBody, auto: true };

  const fromFile = fileBaseName(input.fileName ?? "");
  if (fromFile) return { title: fromFile.slice(0, TITLE_LIMIT), auto: true };

  return { title: TITLE_UNSET, auto: true };
}

export interface ExcerptInput {
  manualExcerpt?:   string;
  aiExcerpt?:       string;
  pageDescription?: string;
  body?:            string;
}

/** 一覧に出す短い抜粋を決める。中身は見出しと同じ掃除を通す。 */
export function deriveExcerpt(input: ExcerptInput = {}): string {
  const picked =
    [input.manualExcerpt, input.aiExcerpt, input.pageDescription, input.body]
      .map(text => cleanText(text ?? ""))
      .find(text => text.length > 0) ?? "";

  return picked.length > EXCERPT_MAX ? `${picked.slice(0, EXCERPT_MAX)}…` : picked;
}
