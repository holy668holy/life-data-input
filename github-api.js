// @ts-check
/**
 * GitHub Contents API で daily-log ファイルを読み書きするモジュール。
 *
 * トークンはこのモジュールの外へ出さない。エラーメッセージにもトークンや応答本文を含めない
 * （画面・コンソールへの流出を防ぐため）。
 */

import {
  CLASSIFIER_STATE_PATH,
  appendEntry,
  buildCommitMessage,
  buildLogPath,
  containsEntry,
  decodeBase64Utf8,
  encodeBase64Utf8,
  formatEntry,
  parseProcessedThrough,
  parseRepoName,
  resolveTargetDate,
} from "./log-format.js";

/** GitHub API の接続先（CSP の connect-src と一致させること） */
const API_BASE = "https://api.github.com";

/** 書き込み競合時に取得からやり直す最大回数（設計書「最大3回」） */
const MAX_CONFLICT_RETRIES = 3;

/** 競合時のやり直し前の待ち時間の基準値（ミリ秒）。1回ごとに2倍にする */
const RETRY_BASE_DELAY_MS = 500;

/** 1回の通信のタイムアウト（ミリ秒） */
const REQUEST_TIMEOUT_MS = 15000;

/** GitHub API の失敗を表す基底クラス */
export class GitHubApiError extends Error {
  /**
   * @param {string} message 利用者向けのメッセージ
   * @param {number | null} status HTTP ステータス（通信自体の失敗なら null）
   */
  constructor(message, status) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

/** トークンの期限切れ・権限不足（401/403） */
export class GitHubAuthError extends GitHubApiError {
  /** @param {number} status HTTP ステータス */
  constructor(status) {
    super("トークンが無効か、権限が足りません。設定からトークンを入力し直してください", status);
    this.name = "GitHubAuthError";
  }
}

/** 同時書き込みによる競合（やり直しても解消しなかった場合に投げる） */
export class GitHubConflictError extends GitHubApiError {
  /** @param {number} status HTTP ステータス */
  constructor(status) {
    super("ほかの書き込みと競合しました。しばらくしてから再送してください", status);
    this.name = "GitHubConflictError";
  }
}

/**
 * GitHub API を呼び出す。
 *
 * @param {string} token アクセストークン
 * @param {string} path API のパス（先頭の / を含む）
 * @param {RequestInit} [init] fetch のオプション
 * @returns {Promise<Response>} 応答
 */
async function callApi(token, path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...init,
      // GitHub の応答はブラウザにキャッシュされうるため、常に最新を取りに行く（古い sha による競合を防ぐ）
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch {
    // 圏外・タイムアウトなど。元の例外にはURL等が含まれうるため、利用者向けの文言に置き換える
    throw new GitHubApiError("通信できませんでした。電波の良い場所で再送してください", null);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 応答ステータスを確認し、失敗なら種類に応じた例外を投げる。
 *
 * @param {Response} response 応答
 */
function assertOk(response) {
  if (response.ok) {
    return;
  }
  if (response.status === 401 || response.status === 403) {
    throw new GitHubAuthError(response.status);
  }
  if (response.status === 404) {
    throw new GitHubApiError("リポジトリが見つかりません。設定のリポジトリ名とトークンの対象を確認してください", 404);
  }
  throw new GitHubApiError(`GitHub への書き込みに失敗しました（ステータス ${response.status}）`, response.status);
}

/**
 * Contents API のパスを作る。
 *
 * @param {string} repoFullName `owner/repo`
 * @param {string} filePath リポジトリ直下からのファイルパス
 * @returns {string} API のパス
 */
function contentsPath(repoFullName, filePath) {
  const { owner, repo } = parseRepoName(repoFullName);
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
}

/**
 * リポジトリ内のファイルを取得する。
 *
 * @param {string} token アクセストークン
 * @param {string} repoFullName `owner/repo`
 * @param {string} filePath リポジトリ直下からのファイルパス
 * @returns {Promise<{content: string, sha: string | null}>} 内容と sha。ファイルが無ければ空文字と null
 */
async function fetchRepoFile(token, repoFullName, filePath) {
  const response = await callApi(token, contentsPath(repoFullName, filePath));
  if (response.status === 404) {
    // 404 は「ファイルが無い」と「リポジトリが見えない」の両方がありうる。
    // 後者は書き込み時の PUT でも 404 になり、そこで利用者に伝わる
    return { content: "", sha: null };
  }
  assertOk(response);
  const data = await response.json();
  if (typeof data.content !== "string" || typeof data.sha !== "string") {
    throw new GitHubApiError("GitHub の応答が想定と異なります（ファイルではない可能性があります）", response.status);
  }
  return { content: decodeBase64Utf8(data.content), sha: data.sha };
}

/**
 * 指定日の daily-log ファイルを取得する。
 *
 * @param {string} token アクセストークン
 * @param {string} repoFullName `owner/repo`
 * @param {string} date 日付（YYYY-MM-DD）
 * @returns {Promise<{content: string, sha: string | null}>} 内容と sha。ファイルが無ければ空文字と null
 */
export function fetchDailyLog(token, repoFullName, date) {
  return fetchRepoFile(token, repoFullName, buildLogPath(date));
}

/**
 * 分類 Skill の状態ファイルから、分類済みの最終日（`processed_through`）を取得する。
 *
 * @param {string} token アクセストークン
 * @param {string} repoFullName `owner/repo`
 * @returns {Promise<string | null>} 分類済みの最終日（YYYY-MM-DD）。状態ファイルが無ければ null
 */
export async function fetchProcessedThrough(token, repoFullName) {
  const { content } = await fetchRepoFile(token, repoFullName, CLASSIFIER_STATE_PATH);
  try {
    return parseProcessedThrough(content);
  } catch (error) {
    // 形式が不正なら黙って元の日付に書かず、未送信に残すためエラーにする（Fail Fast）
    throw new GitHubApiError(error instanceof Error ? error.message : String(error), null);
  }
}

/**
 * 指定日の daily-log ファイルの末尾にエントリを追記する。
 *
 * 同時に別の書き込みがあって sha が古くなっていた場合は、取得からやり直す。
 * `skipIfDuplicate` が true で同じエントリが既に書き込まれていれば何もしない
 * （通信が途中で切れたが実は書き込めていた記録の、再送時の二重書き込み防止）。
 *
 * @param {string} token アクセストークン
 * @param {string} repoFullName `owner/repo`
 * @param {string} date 日付（YYYY-MM-DD）
 * @param {string} entry formatEntry で作ったエントリ
 * @param {{skipIfDuplicate?: boolean, retryBaseDelayMs?: number}} [options]
 *   skipIfDuplicate: 重複判定を行うか（既定 false。再送時だけ true にする）。
 *   retryBaseDelayMs: やり直し前の待ち時間の基準値（テストで短くするために指定できる）
 * @returns {Promise<{content: string, isDuplicate: boolean}>} 書き込み後のファイル内容と、既に書き込み済みだったか
 */
export async function appendToDailyLog(token, repoFullName, date, entry, options = {}) {
  const { skipIfDuplicate = false, retryBaseDelayMs = RETRY_BASE_DELAY_MS } = options;
  for (let attempt = 0; ; attempt += 1) {
    const current = await fetchDailyLog(token, repoFullName, date);
    if (skipIfDuplicate && containsEntry(current.content, entry)) {
      return { content: current.content, isDuplicate: true };
    }
    const nextContent = appendEntry(current.content, entry);
    const response = await callApi(token, contentsPath(repoFullName, buildLogPath(date)), {
      method: "PUT",
      body: JSON.stringify({
        message: buildCommitMessage(date),
        content: encodeBase64Utf8(nextContent),
        // 新規作成時は sha を付けない
        ...(current.sha ? { sha: current.sha } : {}),
      }),
    });
    if (response.ok) {
      return { content: nextContent, isDuplicate: false };
    }
    if (!isConflict(response.status, current.sha !== null)) {
      assertOk(response);
    }
    if (attempt >= MAX_CONFLICT_RETRIES) {
      throw new GitHubConflictError(response.status);
    }
    await sleep(retryBaseDelayMs * 2 ** attempt);
  }
}

/**
 * 未送信の記録を再送する（重複判定あり）。
 *
 * 元の記録日が分類済み（`processedThrough` 以前）なら、今日のファイルへ元の日時の注記付きで書く。
 * その場合、元の日付のファイルに既に同じ記録が入っていれば（以前の送信が実は成功していた）、書き込まない。
 *
 * @param {string} token アクセストークン
 * @param {string} repoFullName `owner/repo`
 * @param {{text: string, date: string, time: string}} record 再送する記録（日付・時刻は入力時のもの）
 * @param {string | null} processedThrough 分類済みの最終日（状態ファイルが無ければ null）
 * @param {string} today 今日の日付（YYYY-MM-DD）
 * @param {{retryBaseDelayMs?: number}} [options] appendToDailyLog に渡すオプション
 * @returns {Promise<{content: string | null, writtenDate: string, isDuplicate: boolean, isRedirected: boolean}>}
 *   書き込み後の内容（元の日付で重複と分かった場合は null）、書き込み先の日付、重複だったか、今日へ振り替えたか
 */
export async function appendResentRecord(token, repoFullName, record, processedThrough, today, options = {}) {
  const targetDate = resolveTargetDate(record.date, processedThrough, today);
  if (targetDate === record.date) {
    const result = await appendToDailyLog(token, repoFullName, targetDate, formatEntry(record.text, record.time), {
      ...options,
      skipIfDuplicate: true,
    });
    return { ...result, writtenDate: targetDate, isRedirected: false };
  }
  // 振り替える場合: 以前の送信が元の日付のファイルに書けていないかを先に確認する
  const original = await fetchDailyLog(token, repoFullName, record.date);
  if (containsEntry(original.content, formatEntry(record.text, record.time))) {
    return { content: null, writtenDate: record.date, isDuplicate: true, isRedirected: true };
  }
  const annotatedEntry = formatEntry(record.text, record.time, record.date);
  const result = await appendToDailyLog(token, repoFullName, targetDate, annotatedEntry, {
    ...options,
    skipIfDuplicate: true,
  });
  return { ...result, writtenDate: targetDate, isRedirected: true };
}

/**
 * 書き込み失敗が「取得し直せば解消しうる競合」かを判定する。
 *
 * - 409: sha が古い（ほかの書き込みが先に入った）
 * - 422（sha なしで送った場合のみ）: 取得後にほかの書き込みでファイルが作られた
 *
 * @param {number} status HTTP ステータス
 * @param {boolean} hasSha sha を付けて送ったか
 * @returns {boolean} 競合なら true
 */
export function isConflict(status, hasSha) {
  return status === 409 || (status === 422 && !hasSha);
}

/**
 * 指定ミリ秒待つ。
 *
 * @param {number} ms 待ち時間
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
