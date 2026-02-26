# MoraCollect

MoraCollect is a corpus collection web app.
This repository currently implements Step 0-9 and Step10-A scope from `DESIGN.md`:

- Step 0: public web page on Firebase Hosting
- Step 1: Google sign-in/sign-out with Firebase Auth
- Step 2: authenticated `/v1/ping` API check
- Step 3: profile display name save/load via Firestore
- Step 4: browser recording UI (record/stop/playback + waveform)
- Step 5: signed URL issue + manual upload to Cloud Storage
- Step 6: register metadata (`/v1/register`) + my records (`/v1/my-records`)
- Step 7: script/prompt selection UI + prompt progress stats (`total_records`, `unique_speakers`)
- Step 8: delete own records (Firestore + Storage) via `DELETE /v1/my-records/{record_id}`
- Step 9: top contributors leaderboard (`GET /v1/leaderboard`)
- Step 10-A: admin batch export (raw download + wav conversion with phoneme filename)

Beginner tutorials (JP):

- `01-Tutorial-Step0-Step1.md`
- `02-Tutorial-Step2-API-Ping.md`
- `03-Tutorial-Step3-Profile.md`
- `04-Tutorial-Step4-Recording-Only.md`
- `05-Tutorial-Step5-Upload-URL.md`
- `06-Tutorial-Step6-Register-Records.md`
- `07-Tutorial-Step7-Prompt-Selection.md`
- `08-Tutorial-Step8-Delete-Own-Records.md`
- `09-Tutorial-Step9-Leaderboard.md`
- `10-Tutorial-Step10-Admin-Wav-Export.md`

## Tech stack (current)

- Frontend: Vite + Vanilla TypeScript (`web/`)
- Auth: Firebase Authentication (Google provider)
- Hosting: Firebase Hosting

## 1. Setup

### 1-1. Install dependencies

```bash
cd web
npm install
```

### 1-2. Configure Firebase Web SDK env vars

```bash
cd web
cp .env.example .env.local
```

Fill `.env.local` with your Firebase Web App config values:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MEASUREMENT_ID` (optional)
- `VITE_API_BASE_URL` (Step2 API URL, e.g. `http://localhost:8080`)

Where to find these values in Firebase Console:

1. Project settings
2. General
3. Your apps (Web app)
4. `firebaseConfig`

Mapping:

- `VITE_FIREBASE_API_KEY` <- `firebaseConfig.apiKey`
- `VITE_FIREBASE_AUTH_DOMAIN` <- `firebaseConfig.authDomain`
- `VITE_FIREBASE_PROJECT_ID` <- `firebaseConfig.projectId`
- `VITE_FIREBASE_APP_ID` <- `firebaseConfig.appId`
- `VITE_FIREBASE_MEASUREMENT_ID` <- `firebaseConfig.measurementId` (optional)
- `VITE_API_BASE_URL` <- your API base URL (`http://localhost:8080` in local dev, Cloud Run URL in production)

### 1-3. Configure Firebase project id for CLI

Edit `.firebaserc` and replace `your-firebase-project-id` with your real project id.

## 2. Local development

```bash
cd web
npm run dev
```

Open the local URL shown by Vite and verify:

- Not signed in: only `Sign in with Google`
- Signed in: account name/email and `Logout`
- Reload keeps the signed-in session

## 3. Deploy to Firebase Hosting

```bash
cd web
npm run build
cd ..
firebase deploy --only hosting
```

After deploy, open the Hosting URL and verify the same auth behavior.

## 4. Firebase console checks

In Firebase Console:

1. Authentication > Sign-in method > enable `Google`
2. Authentication > Settings > add Hosting domain to authorized domains if needed
3. Create/Register a Web app and use its config in `web/.env.local`

## 5. Step2: Authenticated API ping (`/v1/ping`)

### 5-1. Run API locally

```bash
cd api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```

### 5-2. Verify API responses

```bash
curl -i http://localhost:8080/healthz
curl -i http://localhost:8080/v1/ping
```

Expected:

- `/healthz` -> `200`
- `/v1/ping` without auth header -> `401`

### 5-3. Connect web to local API

Set `VITE_API_BASE_URL=http://localhost:8080` in `web/.env.local`, then:

```bash
cd web
npm run dev
```

After sign-in, UI should call `/v1/ping` and show `uid`.

### 5-4. Deploy API to Cloud Run

```bash
gcloud run deploy moracollect-api \
  --source api \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_PROJECT_ID=moracollect-watlab
```

After deployment, set `VITE_API_BASE_URL` in `web/.env.local` to the Cloud Run URL, then rebuild and redeploy hosting:

```bash
cd web
npm run build
cd ..
firebase deploy --only hosting
```

## 6. Step3: Profile display name (`/v1/profile`)

### 6-1. New API endpoints

- `GET /v1/profile` (auth required)
- `POST /v1/profile` (auth required)
  - request: `{"display_name":"..."}`
  - validation: trim + 2 to 20 chars

### 6-2. Firestore document

- `users/{uid}`
  - `display_name`
  - `created_at` (first save only)
  - `updated_at` (every save)
  - `role` (`collector` default on first save)

### 6-3. Web behavior

- Signed-in users see a display name input and Save button
- Save result is shown in UI (`Saved` or error message)
- Reload keeps display name by loading `/v1/profile`

### 6-4. Local checks

```bash
curl -i http://localhost:8080/v1/profile
curl -i -X POST http://localhost:8080/v1/profile -H "Content-Type: application/json" -d '{"display_name":"Taro"}'
```

Expected without auth header:

- both endpoints return `401`

### 6-5. Deploy updates

```bash
gcloud run deploy moracollect-api \
  --source api \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_PROJECT_ID=moracollect-watlab

cd web
npm run build
cd ..
firebase deploy --only hosting
```

## 7. Step4: Recording UI (no upload)

### 7-1. Behavior

- Signed-in users can:
  - Start recording
  - Stop manually
  - Auto-stop at 5 seconds
  - Playback recorded audio in browser
  - Show raw waveform with 1-second time axis after recording
  - Record again
- Validation:
  - under 1 second -> error (`too short`)
  - 1 second or longer -> valid (auto-stop around 5 seconds)
- Waveform:
  - Drawn only after recording is completed (no realtime drawing)
  - Raw time-domain signal is shown on canvas
  - x-axis labels are shown every 1 second
  - Draw density targets about 5kHz (points = round(durationSec * 5000))
  - Point count is clamped for stability (`4000` to `30000`)
  - Browser memory only (not uploaded/saved)

### 7-2. Important note for mobile

- Use HTTPS page (`https://<project-id>.web.app`) on iPhone/Android
- Microphone access is blocked on insecure origins in many mobile browsers

### 7-3. Local check

```bash
cd web
npm run dev
```

After sign-in, verify:

- `Start recording` starts microphone capture
- `Stop` ends capture and shows audio player
- After successful stop, waveform appears under recording controls
- If you do not stop, recording auto-stops at 5 seconds
- `Record again` allows repeated recordings
- Recorded duration may be slightly under/over 5.0s due to browser timer and encoder frame boundaries

### 7-4. Known errors

- Permission denied:
  - Browser/site microphone permission is off
  - On iPhone Chrome, check `Settings > Chrome > Microphone` and reload page
- Not supported:
  - Browser does not provide MediaRecorder
- Too short:
  - Stopped before 1 second

## 8. Step5: Signed upload URL + manual upload

### 8-1. New API endpoint

- `POST /v1/upload-url` (auth required)
  - request: `{"ext":"webm","content_type":"audio/webm"}`
  - response: `record_id`, `raw_path`, `upload_url`, `required_headers`
  - constraints:
    - ext: `webm` or `mp4`
    - content_type: `audio/webm` or `audio/mp4`
    - path is always generated by server: `raw/<uid>/<record_id>.<ext>`
    - URL expiration: `600` sec

### 8-2. Required API env var

- `STORAGE_BUCKET` is required for Step5 API.
- Use your Firebase default bucket name from Firebase Console > Storage.
- Use **bucket name only** (no `gs://` prefix).
  - example: `moracollect-watlab.firebasestorage.app`

Deploy API with both env vars:

```bash
gcloud run deploy moracollect-api \
  --source api \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_PROJECT_ID=moracollect-watlab,STORAGE_BUCKET=<your-default-bucket>
```

### 8-3. Web behavior

- Upload button is disabled when:
  - not signed in
  - no successful recording yet
  - upload is in progress
- After recording succeeds:
  - click `Upload`
  - web requests signed URL
  - web sends `PUT` directly to Cloud Storage
  - UI shows `Saved to: raw/<uid>/<record_id>.<ext>`

### 8-4. CORS note for Cloud Storage

If upload fails with CORS errors in browser console, configure bucket CORS to allow:

- origins:
  - `http://localhost:5173`
  - `https://<project-id>.web.app`
  - `https://<project-id>.firebaseapp.com`
- methods: `PUT`, `GET`, `HEAD`, `OPTIONS`
- response/request headers including `Content-Type`

### 8-5. Step5 completion notes

- Success message:
  - `Upload status: uploaded`
  - `Saved to: raw/<uid>/<record_id>.<ext>`
- Signed URL expiry (`600` sec) is only for the temporary upload URL.
  - Uploaded object itself remains in Storage until explicitly deleted.
- File extension can differ by device/browser:
  - desktop Chrome often `webm`
  - iPhone browsers often `mp4`
  - This is expected in Step5 (raw storage stage).

## 9. Step6: Register metadata + My records

### 9-1. New API endpoints

- `POST /v1/register` (auth required)
  - request:
    - `record_id` (UUID)
    - `raw_path` (`raw/<uid>/<record_id>.<ext>`)
    - `script_id` (selected script id)
    - `prompt_id` (selected prompt id)
    - `client_meta` (optional object)
    - `recording_meta` (optional object: `mime_type`, `size_bytes`, `duration_ms`)
  - response: `record_id`, `status`, `already_registered`
  - validation/errors:
    - `401` auth invalid
    - `400` invalid `record_id` / `raw_path` / uid mismatch
    - `400` invalid `script_id` / `prompt_id`
    - `400` prompt-script mismatch
    - `404` raw object not found in Storage
    - `409` `record_id` is already owned by different uid

- `GET /v1/my-records?limit=...` (auth required)
  - returns only the signed-in user records
  - `limit` default `20`, max `50`

### 9-2. Firestore writes

- Canonical record:
  - `records/{record_id}`
- User history mirror:
  - `users/{uid}/records/{record_id}`
- Step7 stores selected values:
  - `script_id = selected script`
  - `prompt_id = selected prompt`

### 9-3. Web behavior

- After Upload success:
  - web automatically calls `/v1/register`
  - UI shows `Register status: registered` (or `already registered`)
- On register failure:
  - UI shows `Register status: failed (...)`
  - `Retry register` button is enabled
- `My records` list is loaded after sign-in and after successful register

### 9-4. Required IAM for Step6 check

`/v1/register` checks raw object existence in Storage, so Cloud Run service account needs:

- `roles/storage.objectViewer` (read/check object)

Existing Step5 roles for upload URL generation remain required.

### 9-5. Quick verification

1. Sign in
2. Record audio
3. Upload
4. Confirm:
  - `Upload status: uploaded`
  - `Register status: registered` (or `already registered`)
  - `My records` has a new item

## 10. Step7: Script/Prompt selection + progress stats

### 10-1. New API endpoints

- `GET /v1/scripts` (auth required)
  - returns active script list with:
    - `prompt_count`
    - `total_records`
    - `unique_speakers`
- `GET /v1/prompts?script_id=<id>` (auth required)
  - returns active prompts in selected script with:
    - `total_records`
    - `unique_speakers`

### 10-2. Register update

`POST /v1/register` now requires:

- `script_id`
- `prompt_id`

The API validates script/prompt consistency and updates:

- `stats_prompts/{prompt_id}`
- `stats_prompts/{prompt_id}/speakers/{uid}`
- `stats_scripts/{script_id}`
- `stats_scripts/{script_id}/speakers/{uid}`

### 10-3. Seed Step7 data

Seed files:

- `infra/seeds/scripts.json`
- `infra/seeds/prompts.json`

Seed command:

```bash
cd api
python3 -m venv .venv                 # first time only
source .venv/bin/activate
pip install -r requirements.txt       # first time only
# if ADC is not configured:
# gcloud auth application-default login
python3 scripts/seed_step7_data.py
deactivate
```

### 10-4. Web behavior

- Signed-in user selects script from dropdown
- In current default operation:
  - script = `50音` (`s-gojuon`) only
  - prompts = 104 entries in fixed gojuon order
- Prompt buttons are shown in grid (fixed gojuon order by `order`)
- User chooses any prompt and records/uploads
- Upload button is enabled only when:
  - signed in
  - prompt selected
  - recording exists
- Register success refreshes prompt counts immediately
- Current default seed:
  - script: `50音` (`s-gojuon`)
  - prompts: 104 items (46 clear + 25 voiced/semi-voiced + 33 contracted sounds)

### 10-5. Deploy order

1. Deploy API
2. Run seed script
3. Build/deploy web hosting

```bash
gcloud run deploy moracollect-api \
  --source api \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_PROJECT_ID=moracollect-watlab,STORAGE_BUCKET=moracollect-watlab.firebasestorage.app

cd web
npm run build
cd ..
firebase deploy --only hosting
```

### 10-6. Step7 troubleshooting (frequent)

- `Scripts: failed (Not Found)`
  - cause: Web points to wrong/old API URL, or API revision without `/v1/scripts`
  - fix: verify `VITE_API_BASE_URL`, redeploy API, then rebuild/redeploy Hosting
- `ModuleNotFoundError: No module named 'firebase_admin'` (while seed)
  - cause: venv/dependencies are not ready
  - fix: `source .venv/bin/activate` and `pip install -r requirements.txt`
- `DefaultCredentialsError` (while seed)
  - cause: ADC is not configured for Firestore write
  - fix: run `gcloud auth application-default login`
- `UserWarning: ... without a quota project` (while seed)
  - cause: ADC uses user credentials without quota project
  - fix: `gcloud auth application-default set-quota-project moracollect-watlab`
- `prompt ... references unknown script_id ...` (while seed)
  - cause: `scripts.json` and `prompts.json` are inconsistent
  - fix: make prompt `script_id` match existing script (current: `s-gojuon`)
- Old scripts/prompts still shown in UI
  - cause: legacy Firestore seed data remains
  - fix: rerun `seed_step7_data.py` (it prunes missing `scripts/prompts`)

## 11. Step8: Delete own records (hard delete)

### 11-1. New API endpoint

- `DELETE /v1/my-records/{record_id}` (auth required)
  - deletes:
    - `records/{record_id}`
    - `users/{uid}/records/{record_id}`
    - Storage object at `raw_path`
    - Storage object at `wav_path` when present
  - updates:
    - `stats_prompts/{prompt_id}`
    - `stats_scripts/{script_id}`
    - prompt/script speaker docs (`.../speakers/{uid}`) when needed

### 11-2. Error rules

- `401`: auth invalid
- `403`: record belongs to different uid
- `404`: record not found
- `500`: storage delete permission denied (`Storage delete permission denied`)
- `500`: delete operation failed

### 11-3. Web behavior

- `My records` list now has a `Delete` button per row
- Click -> confirmation dialog
- On success:
  - record disappears from My records
  - script/prompt counts are refreshed without full page reload

### 11-4. Quick verification

1. Sign in
2. Upload/Register one record
3. Click `Delete` on that record
4. Confirm:
  - `My records` no longer contains the record
  - selected prompt/script count values decrease

## 12. Step9: Top contributors leaderboard

### 12-1. New API endpoint

- `GET /v1/leaderboard?limit=...` (auth required)
  - query:
    - `limit`: optional, default `10`, max `50`
  - response:
    - `period` is fixed as `"all"`
    - `leaderboard` array of:
      - `rank`
      - `uid`
      - `display_name`
      - `contribution_count`
      - `avatar_url` (optional)
      - `avatar_expires_in_sec`

### 12-2. Ranking rules

- source: `users/{uid}.contribution_count`
- include only:
  - `contribution_count > 0`
  - `is_hidden != true`
- order:
  1. `contribution_count` desc
  2. `display_name` asc (fallback uid)
  3. `uid` asc

### 12-3. Backfill (recommended once)

If you have existing records before Step9 rollout, run:

```bash
cd api
source .venv/bin/activate
python3 scripts/backfill_contribution_counts.py --dry-run
python3 scripts/backfill_contribution_counts.py
deactivate
```

### 12-4. Web behavior

- Menu `管理` block has a `ランキング` button
- Ranking view shows Top 10 only
- `更新` button refreshes leaderboard on demand
- leaderboard is fetched only when ranking view is opened or refreshed
- while ranking view is open, successful register/delete triggers a refresh

### 12-5. Quick verification

1. Sign in with user A, upload/register several records
2. Sign in with user B, upload/register fewer records
3. Open ranking view
4. Confirm:
  - user A rank is above user B
  - count values match expected non-deleted records

## 13. Step10-A: Admin batch export (raw -> wav)

Step10-A adds an admin-only offline workflow.  
The web app/API behavior is unchanged.

### 13-1. What it does

- Reads `records` from Firestore (`status in uploaded/processed`, `raw_path` present)
- Downloads each raw object from Storage
- Converts with ffmpeg to `16kHz mono s16 wav`
- Saves files as:
  - `exports/wav/<phoneme_slug>/<phoneme_slug>__<uid>__<record_id>.wav`
- Writes manifest CSV:
  - `exports/manifests/export_<timestamp>.csv`

### 13-2. New files

- Script: `api/scripts/export_wav_dataset.py`
- Mapping: `infra/mappings/prompt_phonemes.csv`

Mapping CSV columns:

- required: `prompt_id`, `prompt_text`, `phoneme_seq`
- optional: `phoneme_slug` (auto-generated from `phoneme_seq` when omitted)

### 13-3. Prepare environment

```bash
cd api
source .venv/bin/activate
pip install -r requirements.txt
```

Check ffmpeg:

```bash
ffmpeg -version
```

Configure ADC:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project moracollect-watlab
```

### 13-4. Dry run

```bash
cd api
python3 scripts/export_wav_dataset.py \
  --bucket moracollect-watlab.firebasestorage.app \
  --mapping-csv ../infra/mappings/prompt_phonemes.csv \
  --dry-run
```

### 13-5. Full export

```bash
cd api
python3 scripts/export_wav_dataset.py \
  --bucket moracollect-watlab.firebasestorage.app \
  --mapping-csv ../infra/mappings/prompt_phonemes.csv \
  --out-dir ../exports
```

Useful optional flags:

- `--limit <n>`
- `--uid <uid>`
- `--script-id <id>`
- `--prompt-id <id>`
- `--since <ISO8601>`
- `--until <ISO8601>`
- `--overwrite`
- `--keep-temp-raw`

### 13-6. Error handling policy

- Mapping missing -> `failed` (continue)
- Raw object missing -> `failed` (continue)
- ffmpeg failure -> `failed` (continue)
- Final summary prints `total/exported/skipped/failed`

### 13-7. Important notes

- Step10-A is read-only against Firestore (no status update, no qc writeback)
- Cost impact is mainly Storage download + local compute
- Exported artifacts under `exports/` are git-ignored
