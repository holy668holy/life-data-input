// log-format.js のユニットテスト（実行: node --test web-input/tests/）
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  appendEntry,
  buildCommitMessage,
  buildLogPath,
  containsEntry,
  decodeBase64Utf8,
  encodeBase64Utf8,
  escapeBodyLine,
  formatEntry,
  normalizeInput,
  parseEntries,
  parseRepoName,
  toJstDateTime,
} from "../log-format.js";

describe("toJstDateTime", () => {
  test("UTC の時刻を日本時間の日付・時刻に変換する", () => {
    // UTC 2026-10-03 05:07 は日本時間 14:07
    assert.deepEqual(toJstDateTime(new Date("2026-10-03T05:07:00Z")), { date: "2026-10-03", time: "14:07" });
  });

  test("UTC では前日でも日本時間で日付が変わっていれば翌日になる", () => {
    // UTC 2026-10-02 15:30 は日本時間 2026-10-03 00:30
    assert.deepEqual(toJstDateTime(new Date("2026-10-02T15:30:00Z")), { date: "2026-10-03", time: "00:30" });
  });

  test("日本時間の 0 時台を 24 時と表記しない", () => {
    assert.equal(toJstDateTime(new Date("2026-10-02T15:00:00Z")).time, "00:00");
  });

  test("不正な Date はエラーにする", () => {
    assert.throws(() => toJstDateTime(new Date("invalid")), TypeError);
  });
});

describe("normalizeInput", () => {
  test("前後の空白と改行を除去する", () => {
    assert.equal(normalizeInput("  牛乳を買った \n\n"), "牛乳を買った");
  });

  test("空白だけの入力は null を返す", () => {
    assert.equal(normalizeInput(" \n\t "), null);
  });

  test("CRLF を LF にそろえる", () => {
    assert.equal(normalizeInput("a\r\nb\rc"), "a\nb\nc");
  });
});

describe("escapeBodyLine", () => {
  test("# で始まる行は見出しにならないようエスケープする", () => {
    assert.equal(escapeBodyLine("## メモ"), "\\## メモ");
  });

  test("字下げされた # の行もエスケープする", () => {
    assert.equal(escapeBodyLine("  # メモ"), "  \\# メモ");
  });

  test("Setext 見出しの下線になる行をエスケープする", () => {
    assert.equal(escapeBodyLine("---"), "\\---");
  });

  test("= だけの行もエスケープする", () => {
    assert.equal(escapeBodyLine("==="), "\\===");
  });

  test("箇条書きの行はそのまま残す", () => {
    assert.equal(escapeBodyLine("- TV: SONY"), "- TV: SONY");
  });

  test("途中に # を含む行はそのまま残す", () => {
    assert.equal(escapeBodyLine("色は #fff"), "色は #fff");
  });
});

describe("formatEntry", () => {
  test("1行の入力は見出しの末尾に時刻を付ける", () => {
    assert.equal(formatEntry("牛乳を買った", "09:05"), "## 牛乳を買った (09:05)");
  });

  test("複数行の入力は1行目を見出しにし、2行目以降を本文にする", () => {
    assert.equal(
      formatEntry("うちの家電は\n\n- TV: SONY\n- サウンドバー: SONY", "23:53"),
      "## うちの家電は (23:53)\n\n- TV: SONY\n- サウンドバー: SONY",
    );
  });

  test("本文の見出しになりうる行をエスケープする", () => {
    assert.equal(formatEntry("メモ\n# 見出し\n---", "10:00"), "## メモ (10:00)\n\\# 見出し\n\\---");
  });

  test("本文の行末の空白を除去する", () => {
    assert.equal(formatEntry("メモ\n本文  ", "10:00"), "## メモ (10:00)\n本文");
  });

  test("空の入力はエラーにする", () => {
    assert.throws(() => formatEntry("  ", "10:00"));
  });

  test("時刻の形式が不正ならエラーにする", () => {
    assert.throws(() => formatEntry("牛乳", "9:05"));
  });
});

describe("appendEntry", () => {
  test("空のファイルにはエントリと末尾改行だけを書く", () => {
    assert.equal(appendEntry("", "## a (10:00)"), "## a (10:00)\n");
  });

  test("既存の内容とは空行1行で区切る", () => {
    assert.equal(appendEntry("## a (10:00)\n", "## b (11:00)"), "## a (10:00)\n\n## b (11:00)\n");
  });

  test("既存の末尾の余分な空行は1行にまとめる", () => {
    assert.equal(appendEntry("## a (10:00)\n\n\n", "## b (11:00)"), "## a (10:00)\n\n## b (11:00)\n");
  });
});

describe("containsEntry", () => {
  test("同じエントリが含まれていれば true", () => {
    assert.equal(containsEntry("## a (10:00)\n\n## b (11:00)\n", "## b (11:00)"), true);
  });

  test("時刻が違えば false", () => {
    assert.equal(containsEntry("## a (10:00)\n", "## a (10:01)"), false);
  });

  test("行の途中に一致するだけなら false", () => {
    assert.equal(containsEntry("## 牛乳とパン (10:00)\n", "パン (10:00)"), false);
  });
});

describe("parseEntries", () => {
  test("見出し単位にタイトル・時刻・本文を取り出す", () => {
    const content = "## 牛乳 (09:00)\n\n## 家電 (10:00)\n- TV\n\\# メモ\n";
    assert.deepEqual(parseEntries(content), [
      { title: "牛乳", time: "09:00", body: "" },
      { title: "家電", time: "10:00", body: "- TV\n\\# メモ" },
    ]);
  });

  test("時刻の無い見出しは time を null にする", () => {
    assert.deepEqual(parseEntries("## うちの家電は\n- TV (23:53)"), [
      { title: "うちの家電は", time: null, body: "- TV (23:53)" },
    ]);
  });

  test("空のファイルは空配列を返す", () => {
    assert.deepEqual(parseEntries(""), []);
  });
});

describe("パス・コミットメッセージ", () => {
  test("日付から daily-log のパスを作る", () => {
    assert.equal(buildLogPath("2026-10-03"), "daily-log/2026-10-03.md");
  });

  test("旧 Slack Bot と同じ形式のコミットメッセージを作る", () => {
    assert.equal(buildCommitMessage("2026-10-03"), "chore: daily-log更新 (2026-10-03.md)");
  });

  test("不正な日付はエラーにする（パスの組み立てに使うため）", () => {
    assert.throws(() => buildLogPath("../secret"));
  });
});

describe("parseRepoName", () => {
  test("所有者とリポジトリ名に分解する", () => {
    assert.deepEqual(parseRepoName(" holy668holy/life-data "), { owner: "holy668holy", repo: "life-data" });
  });

  test("スラッシュが無ければエラーにする", () => {
    assert.throws(() => parseRepoName("life-data"));
  });

  test("パスをさかのぼる名前はエラーにする", () => {
    assert.throws(() => parseRepoName("holy668holy/.."));
  });
});

describe("Base64（UTF-8）", () => {
  test("日本語を含む文字列を往復変換できる", () => {
    const text = "## 牛乳を買った (09:05)\n絵文字も🍶\n";
    assert.equal(decodeBase64Utf8(encodeBase64Utf8(text)), text);
  });

  test("Node.js の Buffer と同じ Base64 になる", () => {
    const text = "洗濯機が壊れた";
    assert.equal(encodeBase64Utf8(text), Buffer.from(text, "utf-8").toString("base64"));
  });

  test("GitHub の応答のように改行を含む Base64 も復元できる", () => {
    const encoded = Buffer.from("あいうえお".repeat(30), "utf-8").toString("base64");
    const wrapped = encoded.replace(/(.{60})/g, "$1\n");
    assert.equal(decodeBase64Utf8(wrapped), "あいうえお".repeat(30));
  });

  test("大きな文字列でも変換できる", () => {
    const text = "あ".repeat(100000);
    assert.equal(decodeBase64Utf8(encodeBase64Utf8(text)), text);
  });

  test("不正な UTF-8 はエラーにする", () => {
    assert.throws(() => decodeBase64Utf8(Buffer.from([0xff, 0xfe]).toString("base64")));
  });
});
