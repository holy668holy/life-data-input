// storage.js のユニットテスト。window.localStorage を Map ベースの代役に差し替えて確認する
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  DEFAULT_REPO,
  StorageUnavailableError,
  addPending,
  loadPending,
  loadRepo,
  loadToken,
  removePending,
  saveRepo,
  saveToken,
} from "../storage.js";

/** localStorage の最小限の代役 */
class FakeStorage {
  constructor() {
    this.items = new Map();
  }
  getItem(key) {
    return this.items.has(key) ? this.items.get(key) : null;
  }
  setItem(key, value) {
    this.items.set(key, String(value));
  }
  removeItem(key) {
    this.items.delete(key);
  }
}

/** アクセスすると例外になる localStorage（プライベートブラウズ等を想定） */
const BROKEN_WINDOW = {
  get localStorage() {
    throw new Error("SecurityError");
  },
};

beforeEach(() => {
  globalThis.window = { localStorage: new FakeStorage() };
});

afterEach(() => {
  delete globalThis.window;
});

describe("トークン", () => {
  test("保存したトークンを読み出せる", () => {
    saveToken("abc");
    assert.equal(loadToken(), "abc");
  });

  test("null を保存すると削除される", () => {
    saveToken("abc");
    saveToken(null);
    assert.equal(loadToken(), null);
  });
});

describe("リポジトリ名", () => {
  test("未設定なら既定値を返す", () => {
    assert.equal(loadRepo(), DEFAULT_REPO);
  });

  test("保存した値を返す", () => {
    saveRepo("someone/other");
    assert.equal(loadRepo(), "someone/other");
  });
});

describe("未送信の記録", () => {
  test("未保存なら空配列を返す", () => {
    assert.deepEqual(loadPending(), []);
  });

  test("追加した順に読み出せる", () => {
    addPending({ text: "a", date: "2026-10-03", time: "10:00" });
    addPending({ text: "b", date: "2026-10-03", time: "11:00" });
    assert.deepEqual(
      loadPending().map((entry) => entry.text),
      ["a", "b"],
    );
  });

  test("指定した記録だけを削除する", () => {
    addPending({ text: "a", date: "2026-10-03", time: "10:00" });
    addPending({ text: "b", date: "2026-10-03", time: "11:00" });
    removePending(loadPending()[0].id);
    assert.deepEqual(
      loadPending().map((entry) => entry.text),
      ["b"],
    );
  });

  test("壊れた保存内容は黙って捨てずにエラーにする", () => {
    window.localStorage.setItem("lifeLogInput.pending", "{}");
    assert.throws(() => loadPending());
  });
});

describe("保存できない環境", () => {
  test("localStorage にアクセスできなければ専用の例外にする", () => {
    globalThis.window = BROKEN_WINDOW;
    assert.throws(() => loadToken(), StorageUnavailableError);
  });
});
