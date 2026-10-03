// @ts-check
/**
 * 生活ログ入力ページの画面描画。
 *
 * 画面要素の取得と、一覧・メッセージの描画だけを扱う（通信や保存の判断は app.js が行う）。
 * 利用者の入力を画面に出すときは必ず textContent を使う（innerHTML は使わない。XSS 対策）。
 */

import { parseEntries } from "./log-format.js";
import * as storage from "./storage.js";

/**
 * id から要素を取得する。見つからなければ HTML と食い違っているのでエラーにする。
 *
 * @template {HTMLElement} T
 * @param {string} id 要素の id
 * @returns {T} 要素
 */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`要素が見つかりません: #${id}`);
  }
  return /** @type {T} */ (element);
}

export const ui = {
  entryForm: /** @type {HTMLFormElement} */ (byId("entry-form")),
  entryText: /** @type {HTMLTextAreaElement} */ (byId("entry-text")),
  sendButton: /** @type {HTMLButtonElement} */ (byId("send-button")),
  status: byId("status"),
  pendingSection: byId("pending-section"),
  pendingList: byId("pending-list"),
  resendButton: /** @type {HTMLButtonElement} */ (byId("resend-button")),
  todayDate: byId("today-date"),
  todayMessage: byId("today-message"),
  todayList: byId("today-list"),
  reloadButton: /** @type {HTMLButtonElement} */ (byId("reload-button")),
  settings: /** @type {HTMLDetailsElement} */ (byId("settings")),
  tokenState: byId("token-state"),
  tokenForm: /** @type {HTMLFormElement} */ (byId("token-form")),
  tokenInput: /** @type {HTMLInputElement} */ (byId("token-input")),
  tokenDelete: /** @type {HTMLButtonElement} */ (byId("token-delete")),
  repoForm: /** @type {HTMLFormElement} */ (byId("repo-form")),
  repoInput: /** @type {HTMLInputElement} */ (byId("repo-input")),
};

/**
 * 送信結果などのメッセージを表示する。色だけに頼らないよう文言にも成否を含める。
 *
 * @param {"success" | "error"} kind 種類
 * @param {string} message 表示する文言
 */
export function showStatus(kind, message) {
  ui.status.hidden = false;
  ui.status.className = `status status--${kind}`;
  ui.status.textContent = message;
}

/**
 * 記録1件を一覧の項目として作る。
 *
 * @param {string} meta 日時などの補足
 * @param {string} text 記録の内容
 * @returns {HTMLLIElement} 一覧の項目
 */
function createEntryItem(meta, text) {
  const item = document.createElement("li");
  item.className = "entry-list__item";
  const metaElement = document.createElement("div");
  metaElement.className = "entry-list__meta";
  metaElement.textContent = meta;
  const textElement = document.createElement("div");
  textElement.textContent = text;
  item.append(metaElement, textElement);
  return item;
}

/** 未送信の記録一覧を描画する（無ければ欄ごと隠す） */
export function renderPending() {
  const pending = storage.loadPending();
  ui.pendingSection.hidden = pending.length === 0;
  ui.pendingList.replaceChildren(
    ...pending.map((entry) => createEntryItem(`${entry.date} ${entry.time}`, entry.text)),
  );
}

/**
 * 今日の記録一覧を描画する。
 *
 * @param {string} content 今日の daily-log ファイルの内容
 */
export function renderToday(content) {
  const entries = parseEntries(content);
  ui.todayMessage.textContent = entries.length === 0 ? "まだ記録はありません" : "";
  // 新しい記録を上に表示する
  ui.todayList.replaceChildren(
    ...entries
      .slice()
      .reverse()
      .map((entry) => createEntryItem(entry.time ?? "", entry.body ? `${entry.title}\n${entry.body}` : entry.title)),
  );
}

/** 設定欄の表示を保存内容に合わせる（トークンそのものは表示しない） */
export function renderSettings() {
  ui.tokenState.textContent = storage.loadToken() ? "保存済み" : "未設定";
  ui.repoInput.value = storage.loadRepo();
}
