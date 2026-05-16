# Homebrew Release (Cosmic)

## 1) Create tap repository

Create this repo on GitHub:
- `TeeyanshShukla/homebrew-cosmic`

Then locally in that repo, create:
- `Formula/cosmic.rb`

## 2) Cut app release

In `TeeyanshShukla/Cosmic`:

```bash
git tag v1.0.0
git push origin v1.0.0
```

This triggers `.github/workflows/release-cli.yml` and uploads:
- `cosmic-darwin-arm64.tar.gz`
- `cosmic-darwin-x64.tar.gz`
- `cosmic-linux-x64.tar.gz`

## 3) Generate Homebrew formula

From Cosmic repo:

```bash
./scripts/update-homebrew-formula.sh 1.0.0 /ABS/PATH/homebrew-cosmic/Formula/cosmic.rb
```

Commit/push in `homebrew-cosmic` repo.

## 4) Install command for users

```bash
brew tap TeeyanshShukla/cosmic
brew install cosmic
```

Then:

```bash
cosmic setup
cosmic install
cosmic start
```

