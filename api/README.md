# API (Step2)

## Local run

```bash
cd api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```

## Local check

```bash
curl -i http://localhost:8080/healthz
curl -i http://localhost:8080/v1/ping
curl -i http://localhost:8080/v1/profile
curl -i -X POST http://localhost:8080/v1/profile \
  -H "Content-Type: application/json" \
  -d '{"display_name":"Taro"}'
```

`/v1/ping` and `/v1/profile` should return `401` without `Authorization: Bearer <ID_TOKEN>`.

## Deploy to Cloud Run

```bash
gcloud run deploy moracollect-api \
  --source api \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_PROJECT_ID=moracollect-watlab
```
