# Cosmic AI Distribution Roadmap (Implemented)

## Phase 1: Portability

- Removed hardcoded Telegram secrets from runtime code.
- Added `.env.example` for fresh-machine setup.
- `cosmic doctor` now validates:
  - Node and npm presence
  - `.env` exists
  - `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_ID`
  - required runtime files

## Phase 2: Professional Launcher

CLI entrypoint: `cosmic`

Commands:
- `cosmic setup`
- `cosmic doctor`
- `cosmic start`
- `cosmic stop`
- `cosmic restart`
- `cosmic status`
- `cosmic logs`
- `cosmic install` (launchd autostart)
- `cosmic uninstall`

## Phase 3: 24/7 Background + Auto-start

Implemented with `launchd`:
- Label: `com.cosmicai.telegram-bot`
- Auto-start at login/reboot
- KeepAlive + crash restart
- Launches `start_bot.sh` monitor loop for resiliency

## Phase 4: Packaging

Added `pkg` build scripts in `package.json`:
- `npm run pkg:mac`
- `npm run pkg:linux`
- `npm run pkg:all`

Added GitHub Actions workflow:
- `.github/workflows/release-cli.yml`
- Builds release artifacts for macOS and Linux on tag push (`v*`)

## Phase 5: Setup UX

`cosmic setup` now guides users to configure Gemini + Telegram keys in `.env`.

## Phase 6: Homebrew

Added template + updater:
- `packaging/homebrew/cosmic.rb.template`
- `scripts/update-homebrew-formula.sh`

## Fresh Mac Test Flow

```bash
npm install
cp .env.example .env
# fill .env with keys
npm link
cosmic doctor
cosmic install
cosmic start
cosmic status
cosmic logs
```

After reboot:

```bash
cosmic status
```

