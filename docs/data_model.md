# Data Model

## SQLite tables

### `prompt_templates`
- `id` (PK)
- `name` (unique)
- `template`
- `created_at`

### `records`
- `id` (PK)
- `created_at`
- `image_path`
- `ocr_text` (nullable, deferred in v1)
- `model_text`
- `model_raw` (JSON)
- `metadata_json` (JSON)
- `searchable_text`
- `embedding_id`
- `prompt_template_id` (FK -> `prompt_templates.id`)
- `prompt_template_name`
- `prompt_text`

### `analysis_runs`
- `id` (PK)
- `created_at`
- `record_id` (FK -> `records.id`)
- `provider`
- `model_name`
- `latency_ms`
- `status`
- `retry_count`
- `error_message`
- `request_metadata` (JSON)
- `retryable`

## Chroma metadata contract
- `record_id`
- `created_at`
- `snippet`
- `prompt_template_name`
- `source`
