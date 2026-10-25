---
name: easy-sign-verify
description: Check a document signed with Easy Sign against Easy Sign's records, using its Transaction ID (ES-YYYYMMDD-XXXXXXXX), and optionally confirm that a PDF is the exact signed copy. Use when the user asks whether an Easy Sign document is genuine, fully signed or voided, or whether a file is the exact signed copy. No API key needed; the PDF is hashed on this computer and never uploaded.
license: MIT
compatibility: Requires Node.js 20 or later and network access to www.easy-sign.ca.
metadata:
  author: Easy Sign
  version: "1.1.0"
---

# Verify a document signed with Easy Sign

1. Find the Transaction ID. It looks like `ES-20261025-1A2B3C4D`. It is printed on the
   audit certificate, and the signed PDF carries it in its document properties rather than
   on the page: run `pdfinfo signed.pdf` (Poppler) and look for
   `Subject: Easy Sign Transaction: ES-...`. If you cannot find it, ask the user.

2. Run the check:

   ```bash
   easy-sign verify ES-20261025-1A2B3C4D signed.pdf
   ```

   The Easy Sign plugin puts the `easy-sign` command on the path. If the shell answers
   `easy-sign: command not found` (in Codex, or when this skill was installed without the
   plugin), run `node <this skill's folder>/scripts/easy-sign-verify.mjs` in its place, with
   the same arguments after `verify`.

   Pass the PDF whenever the user has it: without it, the check shows only that the record
   exists, not that their file is the signed copy. Only the file's SHA-256 hash is sent to
   Easy Sign; the file itself stays on this computer.

3. Tell the user what the last line says, in plain words. Be exact about what was proven:

   - `verification_type: full`: the record exists and **this exact file** is the signed copy.
   - `status: valid` with no file compared: everyone signed, but nothing was proven about any
     particular file. Say so, and offer to check the file.
   - `hash_comparison: unrecognized`: the record exists, but this file is not one of the
     copies Easy Sign holds a hash for. Its integrity is **unknown**. This is normal for the
     audit certificate and for re-saved, printed or scanned copies. Never call it forged or tampered.
   - `status: voided`: the sender voided the document; it is no longer valid.
   - `status: pending`: not everyone has signed yet.
   - `status: not_found`: Easy Sign has no record of this Transaction ID. Check it for typos.

The public endpoint allows 20 checks a minute. If the script says to wait, wait before trying again.
