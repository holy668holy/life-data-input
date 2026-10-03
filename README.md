# 生活ログ入力ページ（web-input）

スマートフォンのブラウザから生活ログを送るための、1画面だけの Web ページです。
送った内容は、非公開リポジトリ `holy668holy/life-data` の `daily-log/YYYY-MM-DD.md`（日本時間の日付）に
GitHub の API で直接追記されます。サーバーは使わず、Mac の起動状態にも依存しません。

このフォルダが入力ページのソースの正本です。公開用リポジトリ `holy668holy/life-data-input` には、
このフォルダの中身をコピーして配置します（GitHub Pages で配信するため）。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | 画面。通信先を `https://api.github.com` に限定する Content-Security-Policy を設定している |
| `style.css` | 見た目 |
| `app.js` | 画面操作（送信・再送・設定） |
| `view.js` | 画面描画（一覧・メッセージの表示） |
| `github-api.js` | GitHub Contents API での読み書き（競合時のやり直し、エラーの分類） |
| `storage.js` | 端末内（`localStorage`）への保存（トークン・リポジトリ名・未送信の記録） |
| `log-format.js` | エントリの整形・日本時間の日付・UTF-8 対応 Base64 などの純粋関数 |
| `manifest.webmanifest`, `icon.png` | ホーム画面に追加したときの名前・アイコン |
| `tests/` | ユニットテスト（Node.js 標準のテストランナー） |

## 使い方

1. ホーム画面に追加したアイコンから開く
2. 入力欄に記録を書いて「送信」を押す（パソコンでは Ctrl / Command + Enter でも送信できる）
3. 「送信しました」と表示されれば完了。下の「今日の記録」にも表示される

- 1行目が見出しになり、2行目以降はその下に本文として入る
- 送信に失敗した記録は「未送信の記録」に残る。電波の良い場所で「まとめて再送」を押す
  （入力した時点の日付・時刻のまま、元の日付のファイルに書き込まれる）
- 新しい記録は、同じ分に同じ内容を続けて送っても、そのまま2件書き込まれる（重複判定はしない）
- 「まとめて再送」のときだけ、同じ記録（見出し・時刻・本文が完全に同じ）が既にファイルにあれば二重には書き込まない
  （通信が途中で切れたが実は書き込めていた記録を、再送で二重にしないため）
- 未送信の記録の日付が分類済み（`daily-log/.claude_integration_state.json` の `processed_through` 以前）の場合は、
  元の日付のファイルに書いても分類されないため、**今日のファイル**に書く。その記録の本文の先頭には
  `（元の記録日時: YYYY-MM-DD HH:MM。分類済みの日付のため今日のファイルに記録）` という注記が入り、
  分類 Skill はこの日付を記録の日付として扱う。再送の完了メッセージにも振り替えた件数が出る
- 既知の限界: 毎晩23:00の分類ルーティンの実行中に再送すると、状態ファイルを読んだ時点では未分類でも、
  書き込みがルーティンの読み取りより後になり、分類されないまま残ることがわずかにある（その場合は `daily-log/` に残る）

## 初回のセットアップ（人間が行う作業）

### 1. 公開リポジトリを作って GitHub Pages を有効にする

1. GitHub で **公開（Public）** リポジトリ `life-data-input` を作る
   （データやトークンは含まれず、HTML/JS/CSS だけを置くリポジトリ）
   **注意**: このアカウント（`holy668holy`）では `life-data-input` 以外の GitHub Pages を公開しないでください
   （理由は下の「セキュリティ上の約束ごと」を参照）。
2. このフォルダの中身を公開リポジトリの直下へコピーしてコミット・push する

   ```bash
   # 例: 公開リポジトリを ~/development/life-data-input に clone 済みの場合
   cp -R ~/development/life-data/web-input/. ~/development/life-data-input/
   cd ~/development/life-data-input
   git add -A && git commit -m "feat: 入力ページを更新" && git push
   ```

3. 公開リポジトリの Settings → Pages で、Source を「Deploy from a branch」、
   Branch を `main` / `/ (root)` にして保存する
4. 数分後、`https://holy668holy.github.io/life-data-input/` で開けることを確認する

`web-input/` を変更したら、同じ手順で公開リポジトリへコピーし直します（初版は手動で同期する運用です）。

### 2. アクセストークン（fine-grained personal access token）を発行する

GitHub の Settings → Developer settings → Personal access tokens → **Fine-grained tokens** →
Generate new token で、次のとおりに作ります。

| 項目 | 設定値 |
|---|---|
| Token name | 例: `life-data-input (iPhone)` |
| Expiration | 有効期限を設定する（例: 1年）。期限が切れたら作り直して再入力する |
| Repository access | **Only select repositories** → `holy668holy/life-data` だけを選ぶ |
| Permissions | Repository permissions の **Contents: Read and write** だけ（Metadata: Read-only は自動で付く） |

- トークンはこのページのソースや公開リポジトリには絶対に書かない
- 発行したトークンはその場でスマホのページに入力し、メモ等には残さない

### 3. スマホで初回設定をする

1. スマホのブラウザ（iPhone は Safari、Android は Chrome）でページを開く
2. **ホーム画面に追加する**（iPhone: 共有ボタン →「ホーム画面に追加」、Android: メニュー →「ホーム画面に追加」）
3. ホーム画面のアイコンから開き、「設定」を開いてトークンを貼り付けて「保存」
4. 書き込み先リポジトリが `holy668holy/life-data` になっていることを確認する

> **注意（iPhone）**: Safari では、ホーム画面に追加していないサイトの保存データ（トークン・未送信の記録）が、
> 7日間使わないと消えることがあります。必ずホーム画面に追加したアイコンから使ってください。
> 消えた場合は、トークンを入力し直せば復旧できます（未送信の記録は戻りません）。

## セキュリティ上の約束ごと

- トークンは端末のブラウザ内（`localStorage`）にだけ保存し、画面・コンソール・エラーメッセージに表示しない
- **このアカウント（`holy668holy`）では `life-data-input` 以外の GitHub Pages を公開しない**。
  GitHub Pages のプロジェクトページは、保存領域（オリジン）が `https://holy668holy.github.io` で共通になる。
  別の Pages を公開すると、そのページのスクリプトから `localStorage` のトークンを読めてしまい、
  トークンの権限（非公開リポジトリ `life-data` の読み書き）が悪用されうる。
  どうしても公開する場合は、入力ページを独自ドメインで配信するなどして保存領域を分ける
- 外部スクリプト（CDN 等）は読み込まない。CSP で読み込み元を自サイト、通信先を GitHub API だけに限定している
- 利用者の入力を画面に表示するときは `textContent` を使い、`innerHTML` は使わない
- 端末をなくした・トークンが漏れた疑いがあるときは、GitHub の Fine-grained tokens の画面でそのトークンを削除する

## テストの実行

Node.js（v20 以上）が必要です。追加のパッケージは使いません。

```bash
node --test 'web-input/tests/*.test.js'
```

## 手元のパソコンで画面を確認する

ES Modules を使っているため、ファイルを直接開く（`file://`）と動きません。簡易サーバーで開きます。

```bash
python3 -m http.server 8000 --directory web-input
# ブラウザで http://localhost:8000/ を開く
```
