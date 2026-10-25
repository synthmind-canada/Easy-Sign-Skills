---
name: easy-sign-verify
description: Check a document signed with Easy Sign against Easy Sign's records, using the Transaction ID printed on it (ES-YYYYMMDD-XXXXXXXX), and optionally confirm that a PDF is the exact signed copy. Use when the user asks whether an Easy Sign document is genuine, fully signed, voided or altered. No API key needed; the PDF is hashed on this computer and never uploaded.
license: MIT
compatibility: Requires Node.js 20 or later and network access to www.easy-sign.ca.
metadata:
  author: Easy Sign
  version: "1.0.0"
---

# Verify a document signed with Easy Sign

1. Find the Transaction ID. It is printed on the signed document and its audit certificate,
   and looks like `ES-20261025-1A2B3C4D`. If the user has only the PDF, read it from the
   document. If you cannot find it, ask the user.

2. Run the check. The script is in this skill's folder: `scripts/easy-sign-verify.mjs`.

   ```bash
   node <this skill's folder>/scripts/easy-sign-verify.mjs ES-20261025-1A2B3C4D signed.pdf
   ```

   The PDF is optional. With it, only the file's SHA-256 hash is sent to Easy Sign;
   the file itself stays on this computer.

3. Tell the user what the last line says, in plain words. Be exact about what was proven:

   - `verification_type: full`: the record exists and **this exact file** is the signed copy.
   - `hash_comparison: unrecognized`: the record exists, but this file is not one of the
     copies Easy Sign holds a hash for. Its integrity is **unknown**. This is normal for the
     audit certificate and for re-saved, printed or scanned copies. Never call it forged or tampered.
   - `status: voided`: the sender voided the document; it is no longer valid.
   - `status: pending`: not everyone has signed yet.
   - `status: not_found`: Easy Sign has no record of this Transaction ID. Check it for typos.

The public endpoint allows 20 checks a minute. If the script says to wait, wait before trying again.
