# Cosmic AI

Cosmic AI is a local-first agent runner with Telegram control, computer-use automation, and a production CLI lifecycle.

## Features

- `cosmic` CLI with service lifecycle commands
- Telegram long-polling bot with admin-only control
- 24/7 background runtime via macOS `launchd`
- Auto-restart after crashes and machine restarts
- Homebrew distribution
- Release automation with GitHub Actions

## Install (Homebrew)

```bash
brew tap TeeyanshShukla/cosmic
brew install cosmic
```

## Quick Start

1. Create config file:

```bash
cp .env.example .env
```

2. Fill `.env` values:

```bash
GEMINI_API_KEY="..."
TELEGRAM_BOT_TOKEN="..."
TELEGRAM_ADMIN_ID="..."
```

3. Validate setup:

```bash
cosmic doctor
```

4. Enable 24/7 auto-start service:

```bash
cosmic install
cosmic start
```

5. Check status/logs:

```bash
cosmic status
cosmic logs
```

## CLI Commands

```bash
cosmic setup
cosmic doctor
cosmic start
cosmic stop
cosmic restart
cosmic status
cosmic logs
cosmic install
cosmic uninstall
```

## Telegram Setup

1. Create a bot with [@BotFather](https://t.me/BotFather)
2. Get your Telegram user ID from [@userinfobot](https://t.me/userinfobot)
3. Put values in `.env`:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_ID`

## macOS Permissions

Grant your terminal app:
- Accessibility
- Screen Recording

Path:
- `System Settings -> Privacy & Security`

## Development

```bash
npm install
npm run cosmic -- help
node cosmic.js doctor
```

## Packaging

```bash
npm run pkg:mac
npm run pkg:linux
npm run pkg:all
```

## Release

- Tag push (`v*`) triggers `.github/workflows/release-cli.yml`
- Builds and publishes release assets for Homebrew formula consumption

## Homebrew Tap

- Source: [TeeyanshShukla/Cosmic](https://github.com/TeeyanshShukla/Cosmic)
- Tap: [TeeyanshShukla/homebrew-cosmic](https://github.com/TeeyanshShukla/homebrew-cosmic)

## Security Notes

- Do not commit `.env`
- Keep production secrets server-side where possible
- Telegram bot access is restricted to configured admin ID

## License

Copyright (c) 2026 Teeyansh Shukla. All rights reserved.

This software and associated source code are proprietary and confidential.

No permission is granted to use, copy, modify, merge, publish, distribute, sublicense, sell, or create derivative works from this software without explicit written permission from the copyright holder.

Unauthorized use, reproduction, or distribution is strictly prohibited.
