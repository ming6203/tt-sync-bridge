# TT-Sync Bridge for SillyTavern

This is a local-only server plugin plus UI extension that connects SillyTavern
to an existing TT-Sync v2 workspace.

## Components

- Server plugin: `/opt/sillytavern/plugins/tt-sync-bridge/`
- UI extension: `/opt/sillytavern/public/scripts/extensions/third-party/tt-sync-bridge/`

The server plugin handles TT-Sync TLS SPKI pinning, Ed25519 device identity,
signed sessions, manifests and file transfer. The browser never receives the
TT-Sync private key.

## Pairing

Generate a one-time pairing link on the TT-Sync server:

```bash
tt-sync --state-dir <state-dir> \
  --config-file <config.toml> \
  pair open --rw --mirror
```

Paste the resulting `tauritavern://tt-sync/pair?...` link into the extension
panel under SillyTavern → Extensions → TT-Sync 中转同步.

## Shared workspace warning

This bridge deliberately uses the same TT-Sync workspace as TauriTavern.
There is no version history and no namespace separation.

- Incremental mode transfers changed/new files and never deletes target-only files.
- Mirror mode makes the source side authoritative and deletes target-only files
  inside the selected common datasets.

Only this conservative dataset intersection is used:

- chats and group chats
- character cards
- world info
- OpenAI/NovelAI/TextGen/Kobold presets
- instruct/context/sysprompt/reasoning prompts
- quick replies
- themes/moving UI
- backgrounds/assets/thumbnails
- user images/files/workflows
- vectors
- extension code and data (`extensions.local`, `extensions.third_party`)

A selective state bridge also syncs:

- current preset state (selected OpenAI/TextGen/etc. preset and parameters)
- SillyTavern user settings from `power_user`
- user names, avatars, persona descriptions and Persona Management data
- Tavern Helper / JS-Slash-Runner global scripts and global variables
- global regex scripts, regex presets and regex allowlists

The state bridge never replaces the whole `settings.json`. Incremental mode
merges scripts/regex by id and preserves target-only entries. Mirror mode makes
the source side authoritative for the selected state. Extension settings are
merged, but `apiKey` and `apiUrl` are intentionally excluded. The bridge extension
itself is excluded from extension-directory sync and mirror deletion.

Excluded on purpose:

- `secrets.json`
- all `_tauritavern/**` datasets
- agent.* datasets

## API

All routes require the normal SillyTavern login and CSRF token.

- `GET /api/plugins/tt-sync-bridge/status`
- `POST /api/plugins/tt-sync-bridge/pair`
- `POST /api/plugins/tt-sync-bridge/sync`
- `GET /api/plugins/tt-sync-bridge/job`
- `POST /api/plugins/tt-sync-bridge/reset`
