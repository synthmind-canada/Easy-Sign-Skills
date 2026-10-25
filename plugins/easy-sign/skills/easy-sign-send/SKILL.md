---
name: easy-sign-send
description: Send PDFs for electronic signature with Easy Sign. Use when the user asks to send a PDF to someone to sign, to request or collect an e-signature by email, or to send each person in a list their own document to sign. Requires an Easy Sign Pro API key in EASY_SIGN_API_KEY.
license: MIT
compatibility: Requires Node.js 20 or later and network access to www.easy-sign.ca.
metadata:
  author: Easy Sign
  version: "1.0.0"
---

# Send PDFs for signature with Easy Sign

Each request emails a real person a link to sign one PDF. A sent email cannot be recalled,
so this skill always works in two steps: **check a plan, then send it only after the user approves it.**

One request = one PDF + one signer. To send different PDFs to different people (or the same
PDF to several people, each signing their own copy), put one row per signer in the plan.
For one PDF that several people must sign together, tell the user to use the Easy Sign web app instead.

The script is in this skill's folder: `scripts/easy-sign-send.mjs`. Run it with
`node <this skill's folder>/scripts/easy-sign-send.mjs`.

## 1. Write the plan

Ask for anything you are missing: each signer's name and email, which PDF goes to whom,
where on the page they sign, and a name for each envelope. Then write a plan file
(for example `signature-plan.json`) next to the documents:

```json
{
  "rows": [
    {
      "name": "Jane Smith",
      "email": "jane@example.com",
      "file": "letters/jane-smith.pdf",
      "envelope_name": "2026 Engagement Letter - Jane Smith",
      "fields": [
        { "type": "signature_date", "page": 2, "preset": "signature_bottom_left" }
      ]
    }
  ]
}
```

Row keys:

| Key | Required | Notes |
|---|---|---|
| `email` | yes | The signer's email. |
| `name` | recommended | Used in the email greeting. |
| `file` or `url` | one of them | `file`: a local PDF up to 3 MB, path relative to the plan. `url`: a public `https://` link to a PDF up to 20 MB (no redirects). Up to 15 pages. |
| `fields` | yes | At least one field. See below. |
| `envelope_name` | recommended | How the envelope is named in the user's dashboard. |
| `locale` | no | Language of the email and signing page: `en` (default), `fr` or `zh-hans`. |
| `file_name` | no | File name the signer sees. Defaults to the file's own name. |

A top-level `"sender_timezone": "America/Toronto"` sets the time zone for dates stamped on
the document. Without it, this computer's time zone is used.

Each field has a `type`, a `page` (starting at 1) and either a `preset` or a `position`:

- `signature_date`: signature and the date they sign, in one box. The usual choice.
- `signature`: signature only.
- `signed_datetime`: the date and time they sign, filled in by Easy Sign.
- `date`: the date the request is **sent**, filled in automatically. Not the signing date.

To place fields precisely (for example on a signature line), read
[references/placing-fields.md](references/placing-fields.md).

## 2. Check the plan

```bash
node <this skill's folder>/scripts/easy-sign-send.mjs check signature-plan.json
```

`check` reads the files and validates every row. It sends nothing and needs no API key.
Fix every line marked `x`. Mention the `!` warnings to the user.

## 3. Get the user's approval

Show the user the plan `check` printed: who gets which document, and where they sign.
Ask plainly, for example: "Send these 6 requests now?" Send only after the user says yes
in this conversation. If the user wants someone else, or another agent, to review the plan
first, stop here and wait.

Before sending, check that every file really belongs to the person in its row
(for example, the name inside the PDF matches the row). Sending one client's document to
another client is a privacy breach.

## 4. Send

```bash
node <this skill's folder>/scripts/easy-sign-send.mjs send signature-plan.json --yes
```

- The API key is read from the environment variable `EASY_SIGN_API_KEY`. Never print it,
  ask the user to paste it into the chat, or write it into a file.
- Rows go out one by one. The script waits and retries by itself when Easy Sign is busy
  or rate-limited (10 requests a minute). A retry never emails anyone twice.
- Results are saved next to the plan as `signature-plan.sent.json`. Running the same
  command again skips rows already sent, so it is safe after an interruption.
- To send a row again on purpose (for example a corrected document), make a **new** plan
  file with just that row. Do not edit or delete the `.sent.json` file to force a resend.

If a command fails with a network error inside a sandbox (for example Codex), network access
is turned off. Ask the user to allow it; in Codex that is `network_access = true` under
`[sandbox_workspace_write]` in `~/.codex/config.toml`.

## 5. Report back

Tell the user, for each row: sent (with the envelope ID), already sent earlier, or not sent
and why. The signer gets an email; the envelope also appears in the user's Easy Sign dashboard
at `https://www.easy-sign.ca/envelope/<envelope_id>`.

The API response also carries a `signing_url`. The script deliberately leaves it out of
everything it prints and saves: it is the signer's personal link, and opening it records a
visit by the signer. Never open, request or share a signer's link.

## When something goes wrong

| What the script says | What to do |
|---|---|
| `EASY_SIGN_API_KEY is not set` | Ask the user to create a key in Easy Sign (Settings > API Keys, Pro plan) and export it in the terminal they start you from. |
| `PRO_REQUIRED` | The API needs an active Easy Sign Pro plan. |
| `KEY_REVOKED`, `KEY_EXPIRED` | Ask the user for a new key. Do not retry. |
| `INVALID_API_KEY` | Check that `EASY_SIGN_API_KEY` holds the whole key. If the same key worked earlier today, Easy Sign may have had a short outage: try once more in a few minutes before asking for a new key. |
| `SAME_EMAIL` | The signer's email is the user's own account email; the API cannot send to it. |
| `DOCUMENT_TOO_MANY_PAGES`, `INVALID_PDF`, `INVALID_FIELD_POSITION` | Fix that row (page numbers must exist in the PDF), check again, confirm, send. |
| `DOCUMENT_URL_FAILED`, `INVALID_URL` | The link must be a direct https link to the PDF itself, with no redirects. Download it and use `file` instead if it is under 3 MB. |
| `STORAGE_EXCEEDED` | The user's Easy Sign storage is full. |
| `QUOTA_EXCEEDED` | The account has reached its envelope limit. Tell the user; do not retry. |
| `EMAIL_FAILED` | The email to that address could not be sent, and nothing was created. Check the address with the user. |
| `no answer from Easy Sign` (exit code 3) | Run the same send command again later. Within 24 hours it cannot send duplicates. If it keeps failing, ask the user to check their dashboard. |
