# UI/Admin API contract for 0.24.0

The UI in `feature/ui-admin-024` consumes the existing 0.23.0 endpoints and does not change the job engine.

## Existing endpoints used

- `GET /api/jobs` and `POST /api/jobs/detail` restore the active operation after a refresh and provide status, progress, ETA and failure rows.
- `POST /api/import/pipeline/start`, `POST /api/import/run/status`, `POST /api/import/run/stop` and `POST /api/import/run/resume` drive the single-button import flow.
- `POST /api/repairs/list` supplies repair rows.
- `POST /api/repairs/action` supports focused `retry`, corrected `writePayloads`, and documented `close` with `note`.

## Progress phases expected from Work

`progress.phase` should use one of these stable values:

1. `starting` — input accepted.
2. `checking` — validation and plan construction.
3. `finalizing_relations` — Generic Relation Finalizer.
4. `writing` — writes are being executed.
5. `complete` — terminal marker; the four stages are complete.

The UI remains compatible with 0.23.0, which currently moves directly from `checking` to `writing`. `progress` should continue to include `completed`, `total`, `percent` and `etaSeconds`.

## Missing semantic re-plan contract

The current repairs API can safely replace the original row's `writePayloads` and retry it, so the admin UI exposes that targeted correction. It cannot persist a corrected entity mapping or target key and rebuild the plan. Work should add this action without changing the existing retry contract:

```json
POST /api/repairs/action
{
  "action": "replan",
  "issueIds": ["job-id|plan-id:index"],
  "correction": {
    "targetEntity": "entity_data_name",
    "targetKey": {"kind": "field", "groupId": "group", "fieldId": "field"},
    "mapping": []
  }
}
```

The response should return a preview containing the rebuilt `writePayloads`, the number of affected records and a revision token. A subsequent `retry` must include that token so stale corrections cannot be applied after the job changes. No UI code assumes that this missing action already exists.

`POST /api/repairs/list` currently returns at most 500 rows. To show exact root-cause counts above that limit, Work should additionally return `groups: [{ rootCauseKey, affectedRecords }]` for the full filtered result. Until then the UI labels visible group counts as “at least” when `truncated` is true.
