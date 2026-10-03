// @ts-check
/**
 * 端末内（localStorage）への保存を扱うモジュール。
 *
 * 保存するのは「アクセストークン」「対象リポジトリ名」「未送信の記録」の3つだけ。
 * プライベートブラウズ等で localStorage が使えない場合は、保存できない旨の例外を投げる
 * （黙って保存に失敗すると、未送信の記録が消えたことに気づけないため）。
 */

/** localStorage のキー（ほかのページと衝突しないよう接頭辞を付ける） */
const KEY_TOKEN = "lifeLogInput.token";
const KEY_REPO = "lifeLogInput.repo";
const KEY_PENDING = "lifeLogInput.pending";

/** 対象リポジトリ名の既定値 */
export const DEFAULT_REPO = "holy668holy/life-data";

/**
 * 未送信の記録。入力した時点の日本時間の日付・時刻を保持し、再送時もそれを使う。
 *
 * @typedef {object} PendingEntry
 * @property {string} id 識別子
 * @property {string} text 正規化済みの入力テキスト
 * @property {string} date 入力時の日付（YYYY-MM-DD、日本時間）
 * @property {string} time 入力時の時刻（HH:MM、日本時間）
 */

/** 端末内に保存できないときの例外 */
export class StorageUnavailableError extends Error {
  constructor() {
    super("この端末のブラウザに保存できません（プライベートブラウズ等を確認してください）");
    this.name = "StorageUnavailableError";
  }
}

/**
 * localStorage から読み出す。
 *
 * @param {string} key キー
 * @returns {string | null} 値（無ければ null）
 */
function read(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    throw new StorageUnavailableError();
  }
}

/**
 * localStorage に書き込む（null なら削除する）。
 *
 * @param {string} key キー
 * @param {string | null} value 値
 */
function write(key, value) {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    throw new StorageUnavailableError();
  }
}

/** @returns {string | null} 保存済みのトークン */
export function loadToken() {
  return read(KEY_TOKEN);
}

/** @param {string | null} token 保存するトークン（null なら削除） */
export function saveToken(token) {
  write(KEY_TOKEN, token);
}

/** @returns {string} 対象リポジトリ名（未設定なら既定値） */
export function loadRepo() {
  return read(KEY_REPO) ?? DEFAULT_REPO;
}

/** @param {string} repo 保存するリポジトリ名 */
export function saveRepo(repo) {
  write(KEY_REPO, repo);
}

/**
 * 未送信の記録を読み出す。壊れたデータは捨てずに例外にする（記録の消失を防ぐため）。
 *
 * @returns {PendingEntry[]} 未送信の記録（古い順）
 */
export function loadPending() {
  const raw = read(KEY_PENDING);
  if (raw === null) {
    return [];
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("未送信の記録の保存形式が不正です");
  }
  return parsed;
}

/**
 * 未送信の記録を末尾に追加する。
 *
 * @param {Omit<PendingEntry, "id">} entry 追加する記録
 */
export function addPending(entry) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  write(KEY_PENDING, JSON.stringify([...loadPending(), { id, ...entry }]));
}

/**
 * 送信に成功した未送信の記録を削除する。
 *
 * @param {string} id 削除する記録の識別子
 */
export function removePending(id) {
  const remaining = loadPending().filter((entry) => entry.id !== id);
  write(KEY_PENDING, remaining.length > 0 ? JSON.stringify(remaining) : null);
}
