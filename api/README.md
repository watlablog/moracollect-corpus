# API (Step2-Step7)

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
curl -i -X POST http://localhost:8080/v1/upload-url \
  -H "Content-Type: application/json" \
  -d '{"ext":"webm","content_type":"audio/webm"}'
curl -i http://localhost:8080/v1/scripts
curl -i "http://localhost:8080/v1/prompts?script_id=s-basic-vowels"
```

`/v1/ping`, `/v1/profile`, `/v1/upload-url`, `/v1/scripts`, and `/v1/prompts` should return `401` without `Authorization: Bearer <ID_TOKEN>`.

## Seed Step7 data

```bash
cd api
python3 scripts/seed_step7_data.py
```

## Deploy to Cloud Run

```bash
gcloud run deploy moracollect-api \
  --source api \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_PROJECT_ID=moracollect-watlab,STORAGE_BUCKET=<your-default-bucket>
```
