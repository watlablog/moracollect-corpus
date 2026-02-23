# 08-Tutorial: Step8 自分の録音データを削除する

この教科書は、Step8 の「自分のデータ削除」を超初学者向けに説明します。  
目的は、**誤って登録した録音を自分で安全に消せる状態**を作ることです。

---

## Chapter 0: このStepのゴール

1. `My records` に `Delete` ボタンが表示される
2. 自分の録音を 1 件ずつ削除できる
3. 削除後、prompt/script 件数が自動で更新される

今回まだやらないこと:

- 他ユーザーのデータ削除
- 一括削除
- wav変換（Step10）

---

## Chapter 1: 削除されるもの（重要）

```mermaid
flowchart LR
  A[Delete click] --> B[DELETE /v1/my-records/{record_id}]
  B --> C[(records/{record_id})]
  B --> D[(users/{uid}/records/{record_id})]
  B --> E[(Storage raw_path)]
  B --> F[(Storage wav_path if exists)]
  B --> G[(stats_prompts/stats_scripts)]
```

> [!IMPORTANT]
> **Key Point: 完全削除**  
> Step8 は「非表示」ではなく、Firestore と Storage の実データを削除します。  
> そのため削除後は元に戻せません。

---

## Chapter 2: API 仕様（最小）

- `DELETE /v1/my-records/{record_id}`（認証必須）

成功:

```json
{
  "ok": true,
  "record_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "deleted": true
}
```

失敗:

- `401`: 未ログイン
- `403`: 他人の record_id
- `404`: record が存在しない
- `500`: サーバ内部エラー

---

## Chapter 3: 画面での使い方

1. サインインする
2. `My records` から削除対象の行を探す
3. `Delete` を押す
4. 確認ダイアログで `OK`
5. `My records` と件数表示が更新されることを確認

---

## Chapter 4: 期待される反映

削除成功後:

1. `My records` から対象行が消える
2. 選択中 prompt の `rec/spk` が必要に応じて減る
3. script 側の `rec/spk` も必要に応じて減る

補足:

- 同じユーザーが同じ prompt を他にも持っている場合、`spk` は減りません
- 最後の1件だった場合のみ `spk` が減ります

---

## Chapter 5: よくあるつまずき

### 5-1. `delete failed (record not found)`

- 原因: すでに削除済み、または古い表示を見ていた
- 対処: ページを再読み込みし、最新の `My records` を確認

### 5-2. `delete failed (record does not belong to authenticated user)`

- 原因: 他ユーザーの record_id を削除しようとした
- 対処: 自分の `My records` からのみ削除操作する

### 5-3. 削除後に件数が変わらないように見える

- 原因候補: API失敗、または別 script/prompt を見ている
- 対処:
  - `My records` ステータスの失敗表示を確認
  - 正しい script/prompt が選択されているか確認

### 5-4. `delete failed (Storage delete permission denied)`

- 原因: Cloud Run の実行サービスアカウントに Storage 削除権限がない
- 対処:
  - バケット `gs://moracollect-watlab.firebasestorage.app` に
    `roles/storage.objectUser` を付与する

---

## Chapter 6: 次のStep

Step8 でデータ運用（削除）が整いました。  
次は Step9 で「Top contributors（ランキング表示）」を追加します。
