// @ts-check
/**
 * 生活ログ入力ページの画面操作。
 *
 * 入力 → 送信 → 結果表示、未送信の記録の再送、今日の記録の読み込み、設定（トークン・リポジトリ）の
 * 操作を扱う。描画そのものは view.js に任せる。
 */

import { GitHubApiError, GitHubAuthError, appendToDailyLog, fetchDailyLog } from "./github-api.js";
import { formatEntry, normalizeInput, parseRepoName, toJstDateTime } from "./log-format.js";
import * as storage from "./storage.js";
import { renderPending, renderSettings, renderToday, showStatus, ui } from "./view.js";

/**
 * 例外を利用者向けの文言に変換する。想定外の例外の詳細は画面に出さずコンソールにだけ残す。
 *
 * @param {unknown} error 例外
 * @returns {string} 利用者向けの文言
 */
function describeError(error) {
  if (error instanceof GitHubApiError || error instanceof storage.StorageUnavailableError) {
    return error.message;
  }
  // GitHubApiError 以外はトークンを含まない（通信はすべて github-api.js 内で行う）ため、記録してよい
  console.error(error);
  return "予期しないエラーが発生しました";
}

/**
 * 認証エラーなら設定欄を開き、トークンの再入力を促す。
 *
 * @param {unknown} error 例外
 */
function openSettingsIfAuthError(error) {
  if (error instanceof GitHubAuthError) {
    ui.settings.open = true;
    ui.tokenInput.focus();
  }
}

/** GitHub から今日のファイルを読み込み、一覧を更新する */
async function reloadToday() {
  const today = toJstDateTime(new Date()).date;
  ui.todayDate.textContent = `（${today}）`;
  const token = storage.loadToken();
  if (!token) {
    ui.todayMessage.textContent = "設定でトークンを保存すると表示されます";
    ui.todayList.replaceChildren();
    return;
  }
  ui.todayMessage.textContent = "読み込み中…";
  try {
    const { content } = await fetchDailyLog(token, storage.loadRepo(), today);
    renderToday(content);
  } catch (error) {
    ui.todayMessage.textContent = `読み込めませんでした: ${describeError(error)}`;
    openSettingsIfAuthError(error);
  }
}

/**
 * 記録1件を GitHub へ送る。トークンが無ければ認証エラーとして扱う。
 *
 * @param {{text: string, date: string, time: string}} record 送る記録（日付・時刻は入力時のもの）
 * @returns {Promise<boolean>} 既に書き込み済みだった（重複として何もしなかった）なら true
 */
async function sendRecord(record) {
  const token = storage.loadToken();
  if (!token) {
    throw new GitHubAuthError(401);
  }
  const entry = formatEntry(record.text, record.time);
  const result = await appendToDailyLog(token, storage.loadRepo(), record.date, entry);
  // 書き込み先が今日のファイルなら、書き込み後の内容で一覧を更新する
  if (record.date === toJstDateTime(new Date()).date) {
    renderToday(result.content);
  }
  return result.isDuplicate;
}

/**
 * ボタンを押せない状態にして処理を実行する（二重送信の防止）。
 *
 * @param {() => Promise<void>} task 実行する処理
 */
async function withButtonsDisabled(task) {
  ui.sendButton.disabled = true;
  ui.resendButton.disabled = true;
  try {
    await task();
  } catch (error) {
    // 各処理で扱いきれなかった例外（端末内への保存失敗など）もここで画面に知らせる
    showStatus("error", describeError(error));
  } finally {
    ui.sendButton.disabled = false;
    ui.resendButton.disabled = false;
  }
}

/** 入力欄の内容を送信する。失敗したら未送信の記録として端末内に残す */
async function handleSubmit() {
  const text = normalizeInput(ui.entryText.value);
  if (text === null) {
    showStatus("error", "入力が空です");
    return;
  }
  // 入力した時点の日本時間で日付・時刻を決める（再送しても変わらない）
  const record = { text, ...toJstDateTime(new Date()) };
  try {
    const isDuplicate = await sendRecord(record);
    ui.entryText.value = "";
    showStatus("success", isDuplicate ? "送信済みの記録でした（重複して書き込んでいません）" : `送信しました（${record.time}）`);
  } catch (error) {
    try {
      storage.addPending(record);
    } catch (storageError) {
      // 端末内にも残せない場合は、入力欄の内容を消さずに知らせる
      showStatus("error", `送信できず、端末内にも保存できませんでした: ${describeError(storageError)}`);
      return;
    }
    ui.entryText.value = "";
    renderPending();
    showStatus("error", `送信に失敗しました。未送信の記録に残しました: ${describeError(error)}`);
    openSettingsIfAuthError(error);
  }
  ui.entryText.focus();
}

/** 未送信の記録を古い順に再送する。認証エラーが出たらそこで止める */
async function handleResend() {
  let sentCount = 0;
  for (const record of storage.loadPending()) {
    try {
      await sendRecord(record);
    } catch (error) {
      renderPending();
      showStatus("error", `再送に失敗しました（${sentCount}件は送信済み）: ${describeError(error)}`);
      openSettingsIfAuthError(error);
      return;
    }
    storage.removePending(record.id);
    sentCount += 1;
  }
  renderPending();
  showStatus("success", `未送信の記録を${sentCount}件送信しました`);
}

/**
 * 端末内への保存を実行し、失敗したら画面に知らせる。
 *
 * @param {() => void} action 保存処理
 * @returns {boolean} 成功したら true
 */
function runStorageAction(action) {
  try {
    action();
    return true;
  } catch (error) {
    showStatus("error", describeError(error));
    return false;
  }
}

/** 画面のイベントを登録する */
function bindEvents() {
  ui.entryForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void withButtonsDisabled(handleSubmit);
  });
  // Ctrl / Command + Enter でも送信できるようにする（改行は Enter のまま）
  ui.entryText.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      ui.entryForm.requestSubmit();
    }
  });
  ui.resendButton.addEventListener("click", () => {
    void withButtonsDisabled(handleResend);
  });
  ui.reloadButton.addEventListener("click", () => {
    void reloadToday();
  });
  ui.tokenForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const token = ui.tokenInput.value.trim();
    if (token === "") {
      showStatus("error", "トークンを入力してください");
      return;
    }
    // 保存に失敗しても入力欄にトークンを残さない
    ui.tokenInput.value = "";
    if (!runStorageAction(() => storage.saveToken(token))) {
      return;
    }
    renderSettings();
    showStatus("success", "トークンを保存しました");
    void reloadToday();
  });
  ui.tokenDelete.addEventListener("click", () => {
    if (!runStorageAction(() => storage.saveToken(null))) {
      return;
    }
    renderSettings();
    showStatus("success", "保存済みトークンを削除しました");
    void reloadToday();
  });
  ui.repoForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      parseRepoName(ui.repoInput.value);
    } catch (error) {
      showStatus("error", error instanceof Error ? error.message : String(error));
      return;
    }
    if (!runStorageAction(() => storage.saveRepo(ui.repoInput.value.trim()))) {
      return;
    }
    renderSettings();
    showStatus("success", "書き込み先リポジトリを保存しました");
    void reloadToday();
  });
}

/** 画面を初期化する */
function init() {
  bindEvents();
  try {
    renderSettings();
    renderPending();
  } catch (error) {
    showStatus("error", describeError(error));
  }
  ui.entryText.focus();
  void reloadToday();
}

init();
