# Easy Sign Skills

Official [Agent Skills](https://agentskills.io) for [Easy Sign](https://www.easy-sign.ca),
for Claude Code and Codex.

| Skill | What it does | Needs |
|---|---|---|
| `easy-sign-send` | Sends PDFs for e-signature by email: one PDF and one signer per request, or a list of signers each with their own PDF. | Easy Sign Pro and an API key |
| `easy-sign-verify` | Checks a signed document against Easy Sign's records by its Transaction ID, and whether a PDF is the exact signed copy. | Nothing |

Both are small Node.js scripts with no dependencies, plus instructions for the agent.
They need Node.js 20 or later.

## Install

### Claude Code

In Claude Code:

```
/plugin install easy-sign --marketplace synthmind-canada/Easy-Sign-Skills
```

This adds the Easy Sign marketplace and installs the plugin in one step (Claude Code 2.1.275 or
later). From a terminal, the same is
`claude plugin install easy-sign --marketplace synthmind-canada/Easy-Sign-Skills` (2.1.292 or
later). On older versions, run `/plugin marketplace add synthmind-canada/Easy-Sign-Skills` and then
`/plugin install easy-sign@easy-sign`. If the skills don't show up, run `/reload-plugins`.
To update later, run `claude plugin update easy-sign@easy-sign` in a terminal.

You can then just ask for what you want; the skills are also available as
`/easy-sign:easy-sign-send` and `/easy-sign:easy-sign-verify`. The plugin also gives the agent
an `easy-sign` command (`easy-sign check`, `easy-sign send`, `easy-sign verify`), so you see
short commands instead of long script paths. Because it ships that command, claude.ai and
Cowork don't install this plugin; use Claude Code or Codex.

### Codex

Clone the repository once, then link the skills into your Codex skills folder:

```bash
git clone https://github.com/synthmind-canada/Easy-Sign-Skills.git ~/Easy-Sign-Skills
mkdir -p ~/.agents/skills
ln -s ~/Easy-Sign-Skills/plugins/easy-sign/skills/easy-sign-send ~/.agents/skills/easy-sign-send
ln -s ~/Easy-Sign-Skills/plugins/easy-sign/skills/easy-sign-verify ~/.agents/skills/easy-sign-verify
```

Update later with `git -C ~/Easy-Sign-Skills pull`.

Codex runs commands in a sandbox without network access by default. To let the skills reach
Easy Sign, add this to `~/.codex/config.toml` and restart Codex:

```toml
[sandbox_workspace_write]
network_access = true
```

The same links work for Claude Code without the plugin system: link the two folders into
`~/.claude/skills/` instead.

## Set your API key

1. In Easy Sign, open **Settings > API Keys** (Pro plan) and create a key. Copy it: it is shown once.
2. Put it in your shell profile (for example `~/.zshrc`), not in a chat or a file in your project:

   ```bash
   export EASY_SIGN_API_KEY="es_live_..."
   ```

3. Open a new terminal and start Claude Code or Codex from it.

## Use

Ask in plain words, for example:

> Send each client in clients.csv their engagement letter from the letters folder to sign on page 2.

> Is this the signed copy? The Transaction ID is ES-20261025-1A2B3C4D.

For sending, the agent always works the same way:

1. It writes a plan file (for example `2026-10-25-engagement-letters.json`) listing who gets
   which PDF, where they sign, and your time zone.
2. It checks the plan. This reads your files, compares them with earlier sends in the same
   folder, and sends nothing. It also prints a short fingerprint of the plan.
3. It shows you the plan and waits for your yes. This is the moment to look closely, or to ask
   another agent to review the plan and the PDFs.
4. It sends exactly the plan that was checked: the send command needs the fingerprint `check`
   printed and refuses if the plan or any local PDF changed since. The results are saved next to
   the plan (`<plan>.sent.json`).

The script writes down each row before sending it, and every request carries an idempotency
key made from everything that row sends (signer, PDF, fields, envelope name, time zone). If a
send is interrupted, running the same command again skips what was already sent and repeats the
request that was in progress; Easy Sign recognizes a repeated request for 24 hours, so the signer
is not emailed twice, even if the results file was lost, as long as the row is unchanged. When
the script cannot tell whether a row went out, it says so instead of guessing, and refuses
anything that could send it a second time until you have checked the dashboard.

You can try the flow on the examples in [`examples/`](examples/). They use fictional
`@example.com` addresses, so `check` is safe to run, but don't send them.

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
