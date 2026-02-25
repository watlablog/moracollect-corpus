# API (Step2-Step9)

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
curl -i -X DELETE http://localhost:8080/v1/my-records/00000000-0000-0000-0000-000000000000
curl -i http://localhost:8080/v1/leaderboard
```

`/v1/ping`, `/v1/profile`, `/v1/upload-url`, `/v1/scripts`, `/v1/prompts`, `/v1/leaderboard`, and `DELETE /v1/my-records/{record_id}` should return `401` without `Authorization: Bearer <ID_TOKEN>`.

## Seed Step7 data

```bash
cd api
python3 scripts/seed_step7_data.py
```

## Backfill contribution_count (Step9)

```bash
cd api
python3 scripts/backfill_contribution_counts.py --dry-run
python3 scripts/backfill_contribution_counts.py
```

## Deploy to Cloud Run

```bash
gcloud run deploy moracollect-api \
  --source api \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_PROJECT_ID=moracollect-watlab,STORAGE_BUCKET=<your-default-bucket>
```
