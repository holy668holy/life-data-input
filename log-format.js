// @ts-check
/**
 * 生活ログ入力ページの純粋関数群。
 *
 * エントリの整形・日本時間の日付計算・UTF-8 対応 Base64 変換など、
 * 画面や通信に依存しない処理だけをここに置く（Node.js の `node --test` で単体テストするため）。
 */

/** 日付・時刻を決めるタイムゾーン（端末の設定に関係なく日本時間で記録する） */
export const LOG_TIME_ZONE = "Asia/Tokyo";

/** daily-log の置き場所（リポジトリ直下からの相対パス） */
const DAILY_LOG_DIR = "daily-log";

/** 日本時間の日付・時刻を求めるためのフォーマッタ（毎回生成しないよう使い回す） */
const JST_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: LOG_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  // 24時制で 0〜23 時にする（"24:05" のような表記を避けるため hour12 ではなく hourCycle を使う）
  hourCycle: "h23",
});

/** 見出しと誤認されうる本文行（ATX 見出し `#`）を判定する */
const ATX_HEADING_LIKE = /^(\s*)#/;

/** 直前の行を見出しに変えてしまう行（Setext 見出しの下線 `===` / `---`）を判定する */
const SETEXT_UNDERLINE_LIKE = /^(\s*)([=-]+\s*)$/;

/** 分類 Skill と同じ見出し形式 `## 内容 (HH:MM)` */
const ENTRY_HEADING = /^## (.*?)(?: \((\d{2}:\d{2})\))?\s*$/;

/**
 * 指定時刻を日本時間の日付（YYYY-MM-DD）と時刻（HH:MM）に変換する。
 *
 * @param {Date} when 変換する時刻
 * @returns {{date: string, time: string}} 日本時間の日付と時刻
 */
export function toJstDateTime(when) {
  if (!(when instanceof Date) || Number.isNaN(when.getTime())) {
    throw new TypeError("有効な Date を指定してください");
  }
  // formatToParts で各部分を取り出し、ロケール依存の区切り文字に左右されないようにする
  /** @type {Record<string, string>} */
  const parts = {};
  for (const part of JST_FORMATTER.formatToParts(when)) {
    parts[part.type] = part.value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/**
 * 入力テキストを正規化する。前後の空白を除去し、改行コードを LF にそろえる。
 *
 * @param {string} text 入力欄の内容
 * @returns {string | null} 正規化後のテキスト。空なら null（送信しない）
 */
export function normalizeInput(text) {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return normalized === "" ? null : normalized;
}

/**
 * 本文の1行を、分類 Skill や Markdown 表示で見出しと誤認されないようにエスケープする。
 *
 * - `#` で始まる行 → 先頭の `#` の前にバックスラッシュを付ける（`\#` は Markdown で `#` と表示される）
 * - `===` / `---` だけの行 → 直前の行を見出しにしてしまうため、同様にバックスラッシュを付ける
 *
 * @param {string} line 本文の1行
 * @returns {string} エスケープ後の行
 */
export function escapeBodyLine(line) {
  if (ATX_HEADING_LIKE.test(line)) {
    return line.replace(ATX_HEADING_LIKE, "$1\\#");
  }
  if (SETEXT_UNDERLINE_LIKE.test(line)) {
    return line.replace(SETEXT_UNDERLINE_LIKE, "$1\\$2");
  }
  return line;
}

/**
 * 入力テキストを daily-log のエントリ（末尾改行なし）に整形する。
 *
 * 1行目を `## <1行目> (HH:MM)` の見出しにし、2行目以降はその下に本文として続ける。
 *
 * @param {string} text 正規化済みの入力テキスト（normalizeInput の戻り値）
 * @param {string} time 日本時間の時刻（HH:MM）
 * @returns {string} エントリ文字列
 */
export function formatEntry(text, time) {
  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw new Error(`時刻の形式が不正です: ${time}`);
  }
  const normalized = normalizeInput(text);
  if (normalized === null) {
    throw new Error("空のエントリは作成できません");
  }
  const [firstLine, ...bodyLines] = normalized.split("\n");
  const heading = `## ${firstLine.trim()} (${time})`;
  // 本文の行末の空白は Markdown の改行指定と誤解されやすいので除去する
  const body = bodyLines.map((line) => escapeBodyLine(line.trimEnd()));
  return [heading, ...body].join("\n");
}

/**
 * 既存のファイル内容の末尾にエントリを追記した内容を返す。
 *
 * エントリ同士の間は空行1行で区切り、ファイル末尾は改行1つで終える。
 *
 * @param {string} existing 既存のファイル内容（新規ファイルなら空文字）
 * @param {string} entry formatEntry で作ったエントリ
 * @returns {string} 追記後のファイル内容
 */
export function appendEntry(existing, entry) {
  const trimmed = existing.replace(/\s+$/, "");
  if (trimmed === "") {
    return `${entry}\n`;
  }
  return `${trimmed}\n\n${entry}\n`;
}

/**
 * ファイル内容に同じエントリが既に含まれているかを判定する（再送時の二重書き込み防止用）。
 *
 * @param {string} content ファイル内容
 * @param {string} entry formatEntry で作ったエントリ
 * @returns {boolean} 含まれていれば true
 */
export function containsEntry(content, entry) {
  // 行単位で比較し、見出し行の部分一致（別エントリの途中に一致）を避ける
  const normalizedContent = `\n${content.replace(/\r\n?/g, "\n")}\n`;
  return normalizedContent.includes(`\n${entry}\n`);
}

/**
 * daily-log の Markdown をエントリ単位に分割する（今日の送信済み一覧の表示用）。
 *
 * @param {string} content daily-log ファイルの内容
 * @returns {{title: string, time: string | null, body: string}[]} エントリの一覧（ファイル内の順）
 */
export function parseEntries(content) {
  /** @type {{title: string, time: string | null, body: string}[]} */
  const entries = [];
  /** @type {string[]} */
  let bodyLines = [];
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const match = ENTRY_HEADING.exec(line);
    if (match) {
      // 直前のエントリの本文を確定させてから次のエントリへ進む
      if (entries.length > 0) {
        entries[entries.length - 1].body = bodyLines.join("\n").trim();
      }
      entries.push({ title: match[1], time: match[2] ?? null, body: "" });
      bodyLines = [];
    } else if (entries.length > 0) {
      bodyLines.push(line);
    }
  }
  if (entries.length > 0) {
    entries[entries.length - 1].body = bodyLines.join("\n").trim();
  }
  return entries;
}

/**
 * 日付から daily-log のファイルパスを作る。
 *
 * @param {string} date 日付（YYYY-MM-DD）
 * @returns {string} リポジトリ直下からのパス
 */
export function buildLogPath(date) {
  assertDate(date);
  return `${DAILY_LOG_DIR}/${date}.md`;
}

/**
 * 日付からコミットメッセージを作る（旧 Slack Bot と同じ形式）。
 *
 * @param {string} date 日付（YYYY-MM-DD）
 * @returns {string} コミットメッセージ
 */
export function buildCommitMessage(date) {
  assertDate(date);
  return `chore: daily-log更新 (${date}.md)`;
}

/**
 * `owner/repo` 形式のリポジトリ名を検証して分解する。
 *
 * @param {string} fullName リポジトリ名（例: holy668holy/life-data）
 * @returns {{owner: string, repo: string}} 所有者とリポジトリ名
 */
export function parseRepoName(fullName) {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(fullName.trim());
  if (!match || match[2] === "." || match[2] === "..") {
    throw new Error("リポジトリ名は「所有者/リポジトリ名」の形式で入力してください");
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * 文字列を UTF-8 として Base64 に変換する（btoa は Latin-1 しか扱えないため）。
 *
 * @param {string} text 変換する文字列
 * @returns {string} Base64 文字列
 */
export function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  // 大きな配列を一度に String.fromCharCode へ渡すと引数上限を超えるため、分割して変換する
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * UTF-8 の Base64 文字列を文字列に戻す（GitHub API の応答は途中に改行を含むため除去する）。
 *
 * @param {string} base64 Base64 文字列
 * @returns {string} 元の文字列
 */
export function decodeBase64Utf8(base64) {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // 不正な UTF-8 は置換文字にせずエラーにする（壊れた内容に追記して上書きするのを防ぐ）
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * 日付文字列が YYYY-MM-DD 形式かを検証する。
 *
 * @param {string} date 日付
 */
function assertDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`日付の形式が不正です: ${date}`);
  }
}
