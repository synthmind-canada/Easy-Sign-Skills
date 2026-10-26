# When a send command fails

Read the script's last lines first: they say whether anything was sent for each row.
"Not sent" means no signature request went out for that row. "May have been sent" means there
was no clear answer: follow "A row that may have been sent" in SKILL.md, and never send that
row any other way.

| What the script says | What to do |
|---|---|
| `EASY_SIGN_API_KEY is not set` | Ask the user to create a key in Easy Sign (Settings > API Keys, Pro plan), add it to their shell profile, and start you again from a new terminal. |
| `NETWORK_UNAVAILABLE` (could not connect to Easy Sign) | That try never reached Easy Sign. A row reported as not sent was not sent; a row reported as "may have been sent" had an earlier try with no clear answer, so treat it as such. Run the same command again with network access. In Codex, ask to run it outside the sandbox. If Codex runs without approval prompts it cannot ask: tell the user to add `sandbox_mode = "workspace-write"` above any `[section]` in `~/.codex/config.toml`, plus `network_access = true` under `[sandbox_workspace_write]`, then start Codex again. This applies to every Codex session, so say so. `network_access` alone is not enough. Outside a sandbox, check the internet connection. |
| `EPERM`, `EACCES`, `EROFS` or `operation not permitted` on a file next to the plan (`.sent.json`, `.lock`) | The folder is read-only to you. If the script stopped before printing any row, nothing was sent; otherwise report each printed row as it says. Ask to run the command outside the sandbox. |
| `sender_timezone is missing` | Ask the user for their time zone, add it to the plan, check again. |
| `changed since it was approved` | The plan or a PDF changed after the user said yes. Run `check`, tell the user what changed, and ask again. |
| `already sent this same document` | That person already has this document from another plan. Remove the row, or use Resend in the dashboard to remind them. |
| `was already sent ... and has changed since` | That row already went out. Put it back as it was; for a corrected version, write a new plan with just that row. |
| `may already have been sent` | See "A row that may have been sent" in SKILL.md. |
| `another send or resolve of this plan holds` the lock | Wait for the other run to finish. Delete the `.lock` file only after the user confirms that no send of this plan is running anywhere. |
| `cannot be read` (a `.sent.json` file) | Do not delete it. Show the user the file and the error. |
| `PRO_REQUIRED`, `QUOTA_EXCEEDED` | The API needs an active Easy Sign Pro plan. |
| `KEY_REVOKED`, `KEY_EXPIRED` | The key no longer works. Keys are also revoked automatically when Pro ends: ask the user to check their plan, then create a new key. |
| `INVALID_API_KEY` | Check that `EASY_SIGN_API_KEY` holds the whole key. If the same key worked earlier today, Easy Sign may have had a short outage: try once more in a few minutes before asking for a new key. |
| `SAME_EMAIL` | The signer's email is the user's own account email; the API cannot send to it. |
| `DOCUMENT_TOO_MANY_PAGES`, `DOCUMENT_TOO_LARGE`, `INVALID_PDF`, `INVALID_FIELD_POSITION` | Fix that row (every page number must exist in the PDF; a `url` must be served as a PDF), then check, ask, and send again. |
| `DOCUMENT_URL_FAILED`, `INVALID_URL` | The link must lead straight to the PDF: https, no redirects, answering within 10 seconds. If the file is under 3 MB, download it and use `file` instead. |
| `STORAGE_EXCEEDED` | The user's Easy Sign storage is full. |
| `EMAIL_FAILED` | Easy Sign could not email that address and removed the envelope. Check the address with the user. |
| `Easy Sign was busy` | Nothing was sent for that row. Run the same command again in a few minutes. |
| `no clear answer from Easy Sign` (exit code 3) | The row may have been sent. See "A row that may have been sent" in SKILL.md. |
