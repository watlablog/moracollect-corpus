# MoraCollect

MoraCollect is a corpus collection web app.
This repository currently implements Step 0-3 scope from `DESIGN.md`:

- Step 0: public web page on Firebase Hosting
- Step 1: Google sign-in/sign-out with Firebase Auth
- Step 2: authenticated `/v1/ping` API check
- Step 3: profile display name save/load via Firestore

Beginner tutorials (JP):

- `01-Tutorial-Step0-Step1.md`
- `02-Tutorial-Step2-API-Ping.md`
- `03-Tutorial-Step3-Profile.md`

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
