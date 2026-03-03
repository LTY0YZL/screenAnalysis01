# Security and Privacy Notes

- Local-first default: screenshots, SQLite, and Chroma data stay on local disk.
- Cloud usage gate: UI exposes explicit cloud opt-in flag before Gemini mode usage.
- Engine authorization: non-health routes require per-launch bearer token.
- API key storage: Electron uses OS keychain via `keytar` where available.
- Transport scope: engine binds to loopback (`127.0.0.1`) by default.
- Data deletion: records can be removed by deleting local data directories (`images/`, `sqlite/`, `chroma/`).
- Sensitive content warning: when Gemini mode is selected, users should review cloud consent setting.
