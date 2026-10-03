// github-api.js のユニットテスト。fetch を差し替えて GitHub API を呼ばずに確認する
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  GitHubApiError,
  GitHubAuthError,
  GitHubConflictError,
  appendResentRecord,
  appendToDailyLog,
  fetchDailyLog,
  fetchProcessedThrough,
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
    const result = await appendToDailyLog(TOKEN, REPO, DATE, "## b (11:00)", { retryBaseDelayMs: 0 });
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
    await assert.rejects(appendToDailyLog(TOKEN, REPO, DATE, "## b (11:00)", { retryBaseDelayMs: 0 }), GitHubConflictError);
  });

  test("重複判定を指定すると、同じエントリが既にあれば書き込まずに重複として返す", async () => {
    const calls = mockFetch([fileResponse("## a (10:00)\n")]);
    const result = await appendToDailyLog(TOKEN, REPO, DATE, "## a (10:00)", { skipIfDuplicate: true });
    assert.deepEqual({ isDuplicate: result.isDuplicate, callCount: calls.length }, { isDuplicate: true, callCount: 1 });
  });

  test("既定では同じエントリがあっても追記する（新規送信は重複判定しない）", async () => {
    const calls = mockFetch([fileResponse("## a (10:00)\n", "abc"), { status: 200, body: {} }]);
    const result = await appendToDailyLog(TOKEN, REPO, DATE, "## a (10:00)");
    assert.deepEqual(
      { isDuplicate: result.isDuplicate, content: result.content, callCount: calls.length },
      { isDuplicate: false, content: "## a (10:00)\n\n## a (10:00)\n", callCount: 2 },
    );
  });

  test("重複判定は前方一致では重複としない", async () => {
    const calls = mockFetch([fileResponse("## 牛乳を買った (10:00)\n200円\n", "abc"), { status: 200, body: {} }]);
    const result = await appendToDailyLog(TOKEN, REPO, DATE, "## 牛乳を買った (10:00)", { skipIfDuplicate: true });
    assert.deepEqual({ isDuplicate: result.isDuplicate, callCount: calls.length }, { isDuplicate: false, callCount: 2 });
  });

  test("新規作成時の 422 は取得し直し、sha を付けて書き込む", async () => {
    const calls = mockFetch([
      { status: 404, body: {} },
      { status: 422, body: {} },
      fileResponse("## x (10:30)\n", "created"),
      { status: 200, body: {} },
    ]);
    await appendToDailyLog(TOKEN, REPO, DATE, "## b (11:00)", { retryBaseDelayMs: 0 });
    assert.deepEqual(
      { firstHasSha: "sha" in putBody(calls[1]), retrySha: putBody(calls[3]).sha },
      { firstHasSha: false, retrySha: "created" },
    );
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

/** 状態ファイルの GET 応答を作る */
function stateResponse(processedThrough) {
  return fileResponse(JSON.stringify({ processed_through: processedThrough }), "state-sha");
}

describe("fetchProcessedThrough", () => {
  test("状態ファイルの processed_through を返す", async () => {
    const calls = mockFetch([stateResponse("2026-09-28")]);
    assert.deepEqual(
      { value: await fetchProcessedThrough(TOKEN, REPO), url: calls[0].url },
      {
        value: "2026-09-28",
        url: "https://api.github.com/repos/holy668holy/life-data/contents/daily-log/.claude_integration_state.json",
      },
    );
  });

  test("状態ファイルが無ければ null を返す", async () => {
    mockFetch([{ status: 404, body: {} }]);
    assert.equal(await fetchProcessedThrough(TOKEN, REPO), null);
  });

  test("JSON として読めなければエラーにする", async () => {
    mockFetch([fileResponse("not json")]);
    await assert.rejects(fetchProcessedThrough(TOKEN, REPO), GitHubApiError);
  });

  test("processed_through の形式が不正ならエラーにする", async () => {
    mockFetch([stateResponse("2026/09/28")]);
    await assert.rejects(fetchProcessedThrough(TOKEN, REPO), GitHubApiError);
  });

  test("401 は認証エラーにする", async () => {
    mockFetch([{ status: 401, body: {} }]);
    await assert.rejects(fetchProcessedThrough(TOKEN, REPO), GitHubAuthError);
  });
});

describe("appendResentRecord", () => {
  const RECORD = { text: "牛乳を買った", date: "2026-10-02", time: "10:00" };
  const TODAY = "2026-10-03";

  test("未分類の日付なら元の日付のファイルに書く", async () => {
    const calls = mockFetch([{ status: 404, body: {} }, { status: 201, body: {} }]);
    const result = await appendResentRecord(TOKEN, REPO, RECORD, "2026-09-28", TODAY);
    assert.deepEqual(
      { url: calls[0].url.endsWith("daily-log/2026-10-02.md"), written: result.writtenDate, redirected: result.isRedirected },
      { url: true, written: "2026-10-02", redirected: false },
    );
  });

  test("元の日付のファイルに同じエントリがあれば書き込まない", async () => {
    const calls = mockFetch([fileResponse("## 牛乳を買った (10:00)\n")]);
    const result = await appendResentRecord(TOKEN, REPO, RECORD, "2026-09-28", TODAY);
    assert.deepEqual({ isDuplicate: result.isDuplicate, callCount: calls.length }, { isDuplicate: true, callCount: 1 });
  });

  test("分類済みの日付なら今日のファイルに元の日時の注記付きで書く", async () => {
    const calls = mockFetch([
      { status: 404, body: {} }, // 元の日付のファイルは無い
      { status: 404, body: {} }, // 今日のファイルも無い
      { status: 201, body: {} },
    ]);
    const result = await appendResentRecord(TOKEN, REPO, RECORD, "2026-10-02", TODAY);
    assert.deepEqual(
      {
        todayUrl: calls[1].url.endsWith("daily-log/2026-10-03.md"),
        sent: Buffer.from(putBody(calls[2]).content, "base64").toString("utf-8"),
        redirected: result.isRedirected,
        written: result.writtenDate,
      },
      {
        todayUrl: true,
        sent: "## 牛乳を買った (10:00)\n（元の記録日時: 2026-10-02 10:00。分類済みの日付のため今日のファイルに記録）\n",
        redirected: true,
        written: "2026-10-03",
      },
    );
  });

  test("分類済みで元の日付のファイルに記録が既にあれば、今日のファイルにも書かない", async () => {
    const calls = mockFetch([fileResponse("## 牛乳を買った (10:00)\n")]);
    const result = await appendResentRecord(TOKEN, REPO, RECORD, "2026-10-02", TODAY);
    assert.deepEqual(
      { isDuplicate: result.isDuplicate, content: result.content, callCount: calls.length },
      { isDuplicate: true, content: null, callCount: 1 },
    );
  });

  test("分類済みで今日のファイルに注記付きの同じ記録が既にあれば書き込まない", async () => {
    const annotated = "## 牛乳を買った (10:00)\n（元の記録日時: 2026-10-02 10:00。分類済みの日付のため今日のファイルに記録）\n";
    const calls = mockFetch([{ status: 404, body: {} }, fileResponse(annotated)]);
    const result = await appendResentRecord(TOKEN, REPO, RECORD, "2026-10-02", TODAY);
    assert.deepEqual({ isDuplicate: result.isDuplicate, callCount: calls.length }, { isDuplicate: true, callCount: 2 });
  });
});
