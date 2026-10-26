# Easy Sign Skills

Official [Agent Skills](https://agentskills.io) for [Easy Sign](https://www.easy-sign.ca).
Claude Code and Codex can each do the whole job on their own: write a plan, check it, ask you,
send, and report back.

| Skill | What it does | Needs |
|---|---|---|
| `easy-sign-send` | Sends PDFs for e-signature by email: one PDF and one signer per request, or a list of signers each with their own PDF. | Easy Sign Pro and an API key |
| `easy-sign-verify` | Checks a signed document against Easy Sign's records by its Transaction ID, and whether a PDF is the exact signed copy. | Nothing |

Both are small Node.js scripts with no dependencies, plus instructions for the agent.
They need Node.js 20 or later.

## Install

### Claude Code

In a terminal:

```bash
claude plugin install easy-sign --marketplace synthmind-canada/Easy-Sign-Skills
```

This adds the Easy Sign marketplace and installs the plugin in one step (Claude Code 2.1.292 or
later). Inside a Claude Code session, the same is
`/plugin install easy-sign --marketplace synthmind-canada/Easy-Sign-Skills` (2.1.275 or later).
On older versions, run `/plugin marketplace add synthmind-canada/Easy-Sign-Skills` and then
`/plugin install easy-sign@easy-sign`. If the skills don't show up in a session that was already
open, run `/reload-plugins`. To update later, run `claude plugin update easy-sign@easy-sign`.

The skills are also available as `/easy-sign:easy-sign-send` and `/easy-sign:easy-sign-verify`.
The plugin gives Claude an `easy-sign` command (`easy-sign check`, `easy-sign send`,
`easy-sign verify`), so you see short commands instead of long script paths. Because it ships
that command, claude.ai and Cowork don't install this plugin; use Claude Code or Codex.

### Codex

In a terminal:

```bash
codex plugin marketplace add synthmind-canada/Easy-Sign-Skills
codex plugin add easy-sign@easy-sign
```

Codex runs the same scripts with `node`; the skills tell it how.

To update later, run `codex plugin marketplace upgrade easy-sign`, then start Codex again.
It fetches the latest version and replaces the installed one; you don't need to add the plugin
again.

If your Codex doesn't recognize `plugin`, update it, or link the skills by hand
(see "Without the plugin system" below).

### Without the plugin system

The skills are plain folders. Clone the repository once and link them into your agent's
skills folder (`~/.agents/skills/` for Codex, `~/.claude/skills/` for Claude Code):

```bash
git clone https://github.com/synthmind-canada/Easy-Sign-Skills.git ~/Easy-Sign-Skills
mkdir -p ~/.agents/skills
ln -s ~/Easy-Sign-Skills/plugins/easy-sign/skills/easy-sign-send ~/.agents/skills/easy-sign-send
ln -s ~/Easy-Sign-Skills/plugins/easy-sign/skills/easy-sign-verify ~/.agents/skills/easy-sign-verify
```

For Claude Code, link the same two folders into `~/.claude/skills/` instead. Update later with
`git -C ~/Easy-Sign-Skills pull`.

## Set your API key

1. In Easy Sign, open **Settings > API Keys** (Pro plan) and create a key. Copy it: it is shown once.
2. Put it in your shell profile (for example `~/.zshrc`), not in a chat or a file in your project:

   ```bash
   export EASY_SIGN_API_KEY="es_live_..."
   ```

3. Open a new terminal and start Claude Code or Codex from it.

## Use

Go to the folder with your PDFs, start Claude Code (`claude`) or Codex (`codex`), and ask in
plain words, for example:

> Send each client in clients.csv their engagement letter from the letters folder to sign on page 2.

> Is this the signed copy? The Transaction ID is ES-20261025-1A2B3C4D.

For sending, the agent always works the same way:

1. It writes a plan file (for example `2026-10-25-engagement-letters.json`) listing who gets
   which PDF, where they sign, and your time zone.
2. It checks the plan. This reads your files, compares them with earlier sends in the same
   folder, and sends nothing. It also prints a short fingerprint of the plan.
3. It shows you the plan and waits for your yes in the chat. This is the moment to look closely.
4. It sends exactly the plan that was checked: the send command needs the fingerprint `check`
   printed and refuses if the plan or any local PDF changed since. The results are saved next to
   the plan (`<plan>.sent.json`).

The script writes down each row before sending it, and every request carries an idempotency
key made from everything that row sends (signer, PDF, fields, envelope name, time zone). If a
send is interrupted, running the same command again skips what was already sent and repeats the
request that was in progress; Easy Sign recognizes a repeated request for 24 hours, so the signer
is not emailed twice, even if the results file was lost, as long as the row is unchanged. When
the script cannot tell whether a row went out, it says so instead of guessing, and refuses
anything that could send it a second time until you have checked the dashboard. When it cannot
connect to Easy Sign at all, it stops at once instead of retrying.

You can try the flow on the examples in [`examples/`](examples/). They use fictional
`@example.com` addresses, so `check` is safe to run, but don't send them.

### Network access in Codex

Codex runs commands in a sandbox without network access. Checking a plan doesn't need the
network. When it is time to send (or to verify a document), Codex asks to run that one command
outside the sandbox. Choose **Yes, proceed** when it is the send you just approved in the chat
(the command ends with the plan's fingerprint) or the document check you asked for. That prompt only lets the command run; your yes
to the plan is the one you give in the chat.

If you run Codex without approval prompts, it cannot ask. Let it write in your folder and
reach the network in `~/.codex/config.toml`, then start Codex again. This applies to every Codex
session, not just Easy Sign. Put the first line above any `[section]` in that file:

```toml
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true
```

## Privacy

- `easy-sign-send` uploads each PDF to Easy Sign, which stores it and emails the signer.
  The response includes the signer's personal signing link; the script never prints or saves
  it, so the agent cannot open it by accident (opening it would record a visit by the signer).
- `easy-sign-verify` sends only the Transaction ID and the PDF's SHA-256 hash. The file stays
  on your computer.
- The API key is read from the environment and never written anywhere by these scripts.
  The results file keeps only a short hash of it, to notice when a different key is used.
- Plan files and their `.sent.json` results contain your clients' names and email addresses.
  Keep them out of git and shared folders.

## Testing against another server

Set `EASY_SIGN_BASE_URL` (for example `http://localhost:3000`) to point both scripts somewhere
else. Only `https://` addresses and `localhost` are accepted.

## Development

```bash
npm test
```

The tests run the real scripts against a fake server; they need no network and no API key.

API reference: <https://www.easy-sign.ca/docs/api>

## License

MIT
