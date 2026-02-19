# 03-Tutorial: Step3 表示名プロフィール保存（Firestore）

この教科書は Step3 の実装と確認手順を、つまずきやすい点込みでまとめたものです。

---

## Chapter 0: Step3 のゴール

1. ログイン後に表示名フォームが見える
2. 表示名を保存できる
3. 再読み込み後も表示名が残る

表示名ルール:

- 前後空白を除去（trim）
- 2〜20文字

---

## Chapter 1: 実装済み内容

### 1-1. API 追加

- `GET /v1/profile`（認証必須）
- `POST /v1/profile`（認証必須）

レスポンス:

- `GET /v1/profile`:
  - `{"ok": true, "uid": "...", "display_name": "...", "profile_exists": true|false}`
- `POST /v1/profile`:
  - `{"ok": true, "uid": "...", "display_name": "..."}`

### 1-2. Firestore 保存先

- `users/{uid}`
  - `display_name`
  - `created_at`（初回のみ）
  - `updated_at`（毎回）
  - `role`（初回に `collector` を補完）

### 1-3. Web 追加

- 表示名入力欄
- Save ボタン
- 保存結果メッセージ
- ログイン時に `/v1/profile` 読み込み

---

## Chapter 2: サービス関係図（Step3）

```mermaid
flowchart LR
  B[Browser] -->|Google Login| FA[Firebase Auth]
  B -->|GET/POST /v1/profile| CR[Cloud Run API]
  CR -->|ID token verify| FA
  CR -->|read/write users/{uid}| FS[Firestore]
  B -->|static web| FH[Firebase Hosting]
```

---

## Chapter 3: あなたが次に実行する手順

### 3-1. API を再デプロイ

```bash
export CLOUDSDK_CONFIG=/tmp/moracollect-gcloud
gcloud run deploy moracollect-api \
  --source api \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_PROJECT_ID=moracollect-watlab
```

### 3-2. Web を再ビルド & Hosting 再デプロイ

```bash
cd web
npm run build
cd ..
firebase deploy --only hosting
```

---

## Chapter 4: 動作確認チェックリスト

- [ ] ログイン後に表示名入力欄が出る
- [ ] 2〜20文字で保存すると `Saved` が表示される
- [ ] 1文字や21文字以上は保存できない
- [ ] 再読み込み後に保存済み表示名が表示される
- [ ] Step2 の `API status` も引き続き `connected` になる

---

## Chapter 5: よくある詰まりポイント

### 5-1. 保存しても反映されない

- 原因候補:
  - API だけ更新して Web を再デプロイしていない
  - `VITE_API_BASE_URL` が古い
- 対処:
  1. `web/.env.local` の URL を確認
  2. `npm run build`
  3. `firebase deploy --only hosting`

### 5-2. `401` になる

- 原因候補:
  - 未ログイン
  - Authorization ヘッダ未付与（フロント不整合）
- 対処:
  - いったんログアウト→再ログイン
  - `/v1/ping` も同時に確認

### 5-3. Firestore にデータがない

- 原因候補:
  - Firestore Database 未作成
  - API が別プロジェクトを見ている
- 対処:
  - Firebase Console で Firestore を作成（Native mode）
  - `FIREBASE_PROJECT_ID=moracollect-watlab` で再デプロイ

---

## Chapter 6: 次のステップ

Step3 完了後は `DESIGN.md` の Step4（録音UI）へ進みます。

- MediaRecorder で録音
- 停止後に再生
- 端末差（PC/スマホ）確認

