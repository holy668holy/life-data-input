// github-api.js のユニットテスト。fetch を差し替えて GitHub API を呼ばずに確認する
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  GitHubApiError,
  GitHubAuthError,
  GitHubConflictError,
  appendToDailyLog,
  fetchDailyLog,
  isConflict,
} from "../github-api.js";

const TOKEN = "dummy-token-for-test";
const REPO = "holy668holy/life-data";
const DATE = "2026-10-03";
const ORIGINAL_FETCH = globalThis.fetch;

/**
 * 決められた応答を順に返す fetch の代役を設定し、呼び出し記録を返す。
 *
 * @param {Array<{status: number, body?: unknown} | Error>} responses 返す応答（Error なら通信失敗）
 */
function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("想定より多く fetch が呼ばれました");
    }
    if (next instanceof Error) {
      throw next;
    }
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  };
  return calls;
}

/** GitHub の GET 応答（ファイルあり）を作る */
function fileResponse(content, sha = "sha-1") {
  return { status: 200, body: { content: Buffer.from(content, "utf-8").toString("base64"), sha } };
}

/** PUT リクエストの本文を取り出す */
function putBody(call) {
  return JSON.parse(call.init.body);
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("fetchDailyLog", () => {
  test("既存ファイルの内容と sha を返す", async () => {
    mockFetch([fileResponse("## a (10:00)\n", "abc")]);
    assert.deepEqual(await fetchDailyLog(TOKEN, REPO, DATE), { content: "## a (10:00)\n", sha: "abc" });
  });

  test("404 は新規ファイルとして空の内容を返す", async () => {
    mockFetch([{ status: 404, body: {} }]);
    assert.deepEqual(await fetchDailyLog(TOKEN, REPO, DATE), { content: "", sha: null });
  });

  test("正しい URL とトークンで呼び出す", async () => {
    const calls = mockFetch([{ status: 404, body: {} }]);
    await fetchDailyLog(TOKEN, REPO, DATE);
    assert.equal(calls[0].url, "https://api.github.com/repos/holy668holy/life-data/contents/daily-log/2026-10-03.md");
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  });

  test("401 は認証エラーにする", async () => {
    mockFetch([{ status: 401, body: {} }]);
    await assert.rejects(fetchDailyLog(TOKEN, REPO, DATE), GitHubAuthError);
  });

  test("通信失敗のエラーメッセージにトークンを含めない", async () => {
    mockFetch([new TypeError(`network error ${TOKEN}`)]);
    await assert.rejects(fetchDailyLog(TOKEN, REPO, DATE), (error) => {
      assert.ok(error instanceof GitHubApiError);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
  });
});

describe("appendToDailyLog", () => {
  test("ファイルが無ければ sha なしで新規作成する", async () => {
    const calls = mockFetch([{ status: 404, body: {} }, { status: 201, body: {} }]);
    const result = await appendToDailyLog(TOKEN, REPO, DATE, "## a (10:00)");
    const body = putBody(calls[1]);
    assert.deepEqual(
      { content: result.content, sent: Buffer.from(body.content, "base64").toString("utf-8"), hasSha: "sha" in body },
      { content: "## a (10:00)\n", sent: "## a (10:00)\n", hasSha: false },
    );
  });

  test("既存ファイルには sha を付けて末尾に追記する", async () => {
    const calls = mockFetch([fileResponse("## a (10:00)\n", "abc"), { status: 200, body: {} }]);
    await appendToDailyLog(TOKEN, REPO, DATE, "## b (11:00)");
    const body = putBody(calls[1]);
    assert.deepEqual(
      { sha: body.sha, message: body.message, sent: Buffer.from(body.content, "base64").toString("utf-8") },
      { sha: "abc", message: "chore: daily-log更新 (2026-10-03.md)", sent: "## a (10:00)\n\n## b (11:00)\n" },
    );
  });

  test("409 のときは取得からやり直して書き込む", async () => {
    const calls = mockFetch([
      fileResponse("## a (10:00)\n", "old"),
      { status: 409, body: {} },
      fileResponse("## a (10:00)\n\n## x (10:30)\n", "new"),
      { status: 200, body: {} },
    ]);
    const result = await appendToDailyLog(TOKEN, REPO, DATE, "## b (11:00)", 0);
    assert.deepEqual(
      { sha: putBody(calls[3]).sha, content: result.content },
      { sha: "new", content: "## a (10:00)\n\n## x (10:30)\n\n## b (11:00)\n" },
    );
  });

  test("競合が3回のやり直しでも解消しなければ競合エラーにする", async () => {
    const responses = [];
    for (let count = 0; count < 4; count += 1) {
      responses.push(fileResponse("## a (10:00)\n"), { status: 409, body: {} });
    }
    mockFetch(responses);
    await assert.rejects(appendToDailyLog(TOKEN, REPO, DATE, "## b (11:00)", 0), GitHubConflictError);
  });

  test("同じエントリが既にあれば書き込まずに重複として返す", async () => {
    const calls = mockFetch([fileResponse("## a (10:00)\n")]);
    const result = await appendToDailyLog(TOKEN, REPO, DATE, "## a (10:00)");
    assert.deepEqual({ isDuplicate: result.isDuplicate, callCount: calls.length }, { isDuplicate: true, callCount: 1 });
  });

  test("書き込み時の 403 は認証エラーにする", async () => {
    mockFetch([fileResponse("## a (10:00)\n"), { status: 403, body: {} }]);
    await assert.rejects(appendToDailyLog(TOKEN, REPO, DATE, "## b (11:00)"), GitHubAuthError);
  });

  test("書き込み時の 500 は一般の API エラーにする", async () => {
    mockFetch([fileResponse("## a (10:00)\n"), { status: 500, body: {} }]);
    await assert.rejects(appendToDailyLog(TOKEN, REPO, DATE, "## b (11:00)"), (error) => {
      assert.ok(error instanceof GitHubApiError && !(error instanceof GitHubConflictError));
      assert.equal(error.status, 500);
      return true;
    });
  });
});

describe("isConflict", () => {
  test("409 は競合", () => {
    assert.equal(isConflict(409, true), true);
  });

  test("sha なしで送った 422 は競合（取得後に作られた）", () => {
    assert.equal(isConflict(422, false), true);
  });

  test("sha 付きで送った 422 は競合ではない", () => {
    assert.equal(isConflict(422, true), false);
  });
});
