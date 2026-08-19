Provider diagnostics v0.5.3 expectations:
- HTTP 401/403 => AUTH classification, never quota.
- HTTP 429 is DAILY_QUOTA only when provider body/quotaId explicitly contains a per-day signal.
- Generic 429 => TEMP_RATE_LIMIT and uses Retry-After/retryDelay.
- Sanitized JSONL diagnostics live at data/diagnostics/provider-errors.jsonl.
- YouTube media analysis remains AI-free.
