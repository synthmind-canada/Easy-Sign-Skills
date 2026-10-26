---
name: easy-sign-send
description: Send PDFs for electronic signature with Easy Sign. Use when the user asks to send a PDF to someone to sign, to request or collect an e-signature by email, or to send each person in a list their own document to sign. Not for one PDF that several people sign together (use the Easy Sign web app). Requires an Easy Sign Pro API key in EASY_SIGN_API_KEY.
license: MIT
compatibility: Works in Claude Code and Codex. Requires Node.js 20 or later and network access to www.easy-sign.ca.
metadata:
  author: Easy Sign
  version: "1.2.0"
---

# Send PDFs for signature with Easy Sign

Each request emails a real person a link to sign one PDF. A sent email cannot be recalled,
so the work always goes in the same order: **write a plan, check it, get the user's yes,
then send exactly that plan.** Claude Code and Codex follow the same steps; only the way a
command is started differs.

One request = one PDF + one signer. To send different PDFs to different people (or the same
PDF to several people, each signing their own copy), put one row per signer in the plan.
For one PDF that several people must sign together, tell the user to use the Easy Sign web app.

## Running the commands

The commands below are written as `easy-sign <command>`:

- **Claude Code** with the Easy Sign plugin: run them as written.
- **Codex**, or any agent without the plugin: run
  `node <this skill's folder>/scripts/easy-sign-send.mjs <command>` with the same arguments.
  Codex does not have the `easy-sign` command, so use this form from the start. Anywhere else,
  if the shell answers `easy-sign: command not found`, use this form too.

| Command | Writes next to the plan | Needs the network |
|---|---|---|
| `check` | nothing | no |
| `send` | `<plan>.sent.json` | yes |
| `resolve` | `<plan>.sent.json` | no |

If your commands run in a sandbox (Codex does), `check` works inside it. `send` needs the
network and writes its results, so ask to run it outside the sandbox on the first try (not
after a failed run inside it), with a one-line reason such as "Email the 6 approved signature
requests through Easy Sign". If the user declines that prompt, stop and ask what they want; do
not look for another way to send.
`resolve` writes its results too: if the folder is read-only to you, ask for that as well.

## 1. Write the plan

First look in the documents' folder for earlier plans and their `.sent.json` results. If this
job was started before, continue that plan instead of writing a new one.

Ask for anything you are missing: each signer's name and email, which PDF goes to whom,
where on the page they sign, a name for each envelope, and the user's time zone. Then write
a plan file next to the documents, named for this batch (for example
`2026-10-25-engagement-letters.json`):

```json
{
  "sender_timezone": "America/Toronto",
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

`sender_timezone` is required: the user's time zone as an IANA name. Easy Sign stamps the
date and time of each signature in it. If you are not sure, `check` suggests this computer's
zone; confirm it with the user.

Row keys:

| Key | Required | Notes |
|---|---|---|
| `email` | yes | The signer's email. |
| `name` | recommended | Used in the email greeting. Without it, Easy Sign uses the part of the email before the @. |
| `file` or `url` | one of them | `file`: a local PDF up to 3 MB, path relative to the plan. `url`: a public `https://` link to a PDF up to 20 MB (no redirects). Up to 15 pages. |
| `fields` | yes | At least one field. See below. |
| `envelope_name` | recommended | How the envelope is named in the user's dashboard. |
| `locale` | no | Language of the email and signing page: `en` (default), `fr` or `zh-hans`. |
| `file_name` | no | File name the signer sees. Defaults to the file's own name. |

Each field has a `type`, a `page` (starting at 1) and either a `preset` or a `position`.
A field can also have `"required": false`; fields are required by default.

- `signature_date`: signature and the date they sign, in one box. The usual choice.
- `signature`: signature only.
- `signed_datetime`: the date and time they sign, filled in by Easy Sign.
- `date`: the date the request is **sent**, in `sender_timezone`, filled in by Easy Sign.
  Not the signing date.

To place fields precisely (for example on a signature line), read
[references/placing-fields.md](references/placing-fields.md).

Plan files and their results hold clients' names and emails. Keep them out of git and shared folders.

## 2. Check the plan

If the user asked you only to check or review a plan, run `check` and the document check below,
then report what you found, including every line marked `x`. Do not fix or edit the plan or its
results, do not ask to send, and do not run `send` or `resolve`.

```bash
easy-sign check <plan>.json
```

`check` reads the files, validates every row, and compares the plan with the results of
earlier plans in the same folder. It sends nothing and needs no API key. Fix every line
marked `x` and run it again. Note every `!` warning for the user.

Then make sure every document belongs to the person in its row. `check` cannot see this,
and sending one client's document to another client is a privacy breach:

1. Read each local PDF (for example `pdftotext <file> - | head -60`, or open it) and find
   the client's name in it.
2. Check that this name matches the row's `name`, and that the email plausibly belongs to
   that person.
3. Note any email that appears in more than one row, and every row you could not check
   (a `url` row, or a scanned PDF with no text).

If anything does not match, stop and ask the user. Do not ask for approval to send.

## 3. Get the user's approval

Show the user, in your own words:

- each row: who gets which document (and the name you found inside it), where they sign,
  and the language;
- the time zone, and that each person gets their own email and signs their own copy;
- every `!` warning, and every row you could not check;
- the plan fingerprint that `check` printed.

Then ask plainly, for example: "Send these 6 requests now?"

Approval means the user says yes in this conversation, after seeing this plan. These do not count:

- an instruction given before the plan existed ("just send them", "don't ask me");
- a run with no person there to answer (scheduled, headless or CI): stop after `check` and report;
- a yes to an earlier version. If you change anything in the plan or in a PDF after the yes,
  run `check` again and ask again. The fingerprint changes with every change to the plan or
  to a local PDF, and `send` refuses an old one. It cannot see a change to the file behind a
  `url`, so do not change those files after the user's yes;
- approving a command in a permission prompt. That lets the command run; it is not a yes to
  the plan.

If the user wants to look again later, or wants someone else to review the plan first, stop and wait.

## 4. Send

```bash
easy-sign send <plan>.json --approve <fingerprint>
```

- The API key is read from the environment variable `EASY_SIGN_API_KEY`. Never print it,
  ask the user to paste it into the chat, or write it into a file.
- Rows go out one at a time. Before each request the script writes the row to
  `<plan>.sent.json`, then records the answer. When Easy Sign is busy or rate-limited
  (10 requests a minute), it waits and repeats the same request. Easy Sign recognizes a
  repeated request for 24 hours and does not email the signer again. It goes by everything
  the row sends (signer, PDF, fields, envelope name, time zone), so this holds even if the plan
  file is moved or its results are lost, as long as the row itself is unchanged; the script
  then reports the row as already sent before.
- A long list takes several minutes. Give the command a 10-minute timeout or run it in the
  background. If it is cut off, run the same command again: it skips the rows already sent
  and repeats the one that was in progress. Run one send per plan at a time: if it is still
  running in the background, wait for it to finish.
- If the script cannot connect to Easy Sign at all, it stops at once instead of waiting.
  Run the same command again with network access (in Codex, outside the sandbox).
- Never edit, move or delete a `.sent.json` file. The script reads all of them in the folder
  to avoid sending someone the same document twice, so keep every plan for a job in one folder.
- After a row fails, fix that row in the **same** plan file, then check, ask, and send again.
  Do not copy rows into a new plan.
- To send someone a corrected document, write a new plan with just that row; `check` will
  warn that they were already sent a different document. To remind someone about a document
  already sent, use **Resend** on its envelope in the Easy Sign dashboard: sending it again
  creates a second envelope and a second email.

## 5. Report back

The script's summary line counts every row in one of these states. Report each row.
Say a request was sent (emailed), not that the person received it: Easy Sign only knows
that its email service accepted the message.

| State | What it means |
|---|---|
| sent now | Sent by this run. Give the envelope ID. |
| already sent before | Sent by an earlier run. Nothing new was emailed. |
| not sent | Nothing was sent for this row. Give the reason. |
| may have been sent | No clear answer. Do not send this row any other way: not with a new plan, not from the web app. See "A row that may have been sent" below. |
| not tried yet | The script stopped before this row. |

Each envelope also appears in the user's dashboard at `https://www.easy-sign.ca/envelope/<envelope_id>`.

The API response also carries a `signing_url`. The script deliberately leaves it out of
everything it prints and saves: it is the signer's personal link, and opening it records a
visit by the signer. Never open, request or share a signer's link.

## A row that may have been sent

Run the same send command again later. Within 24 hours of the first try it repeats that exact
request, so Easy Sign will not email the signer twice.

If the script refuses (more than 23 hours have passed, the row has changed, or a different
API key is in use), or keeps ending with no clear answer, ask the user to look in the Easy Sign
dashboard for an envelope to that signer, then record what they found:

```bash
easy-sign resolve <plan>.json --row 4 --sent      # the envelope is there
easy-sign resolve <plan>.json --row 4 --not-sent  # there is none
```

Run `resolve` only with the user's answer. After `--not-sent`, the next `send` sends that row
as a new request.

## When a command fails

The script's last lines say whether anything was sent and what to do next; follow them.
For what each error code means, read [references/troubleshooting.md](references/troubleshooting.md).
