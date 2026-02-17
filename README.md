# MoraCollect

MoraCollect is a corpus collection web app.
This repository currently implements the minimum Step 0-1 scope from `DESIGN.md`:

- Step 0: public web page on Firebase Hosting
- Step 1: Google sign-in/sign-out with Firebase Auth

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
