#!/bin/bash

# 🌌 Cosmic AI - Quick Installer
# This script downloads and sets up Cosmic AI

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║                        🌌 COSMIC AI                          ║${NC}"
echo -e "${CYAN}║                      QUICK INSTALLER                        ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js is not installed!${NC}"
    echo -e "${YELLOW}Please install Node.js from: https://nodejs.org/${NC}"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 16 ]; then
    echo -e "${RED}❌ Node.js version $NODE_VERSION is too old!${NC}"
    echo -e "${YELLOW}Please install Node.js 16 or higher from: https://nodejs.org/${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Node.js $(node -v) - Compatible!${NC}"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm is not installed!${NC}"
    exit 1
fi

echo -e "${GREEN}✅ npm $(npm -v) - Ready!${NC}"

# Create directory
INSTALL_DIR="$HOME/cosmic-ai"
echo -e "${YELLOW}📁 Installing to: $INSTALL_DIR${NC}"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}⚠️  Directory already exists. Updating...${NC}"
    cd "$INSTALL_DIR"
    git pull 2>/dev/null || echo -e "${YELLOW}Not a git repository, manual update needed${NC}"
else
    echo -e "${BLUE}📥 Downloading AI Computer Agent...${NC}"
    git clone https://github.com/TeeyanshShukla/Cosmic.git "$INSTALL_DIR" || {
        echo -e "${RED}❌ Failed to download. Creating directory manually...${NC}"
        mkdir -p "$INSTALL_DIR"
        cd "$INSTALL_DIR"
        echo -e "${YELLOW}Please download the files manually to this directory${NC}"
        exit 1
    }
    cd "$INSTALL_DIR"
fi

# Install dependencies
echo -e "${BLUE}📦 Installing dependencies...${NC}"
npm install

# Run setup
echo -e "${BLUE}⚙️ Running setup...${NC}"
npm run setup

echo
echo -e "${GREEN}🎉 Installation Complete!${NC}"
echo
echo -e "${CYAN}🚀 Quick Start:${NC}"
echo -e "${YELLOW}1. cd $INSTALL_DIR${NC}"
echo -e "${YELLOW}2. cp .env.example .env and fill keys${NC}"
echo -e "${YELLOW}3. npm link && cosmic setup && cosmic doctor${NC}"
echo -e "${YELLOW}4. cosmic install && cosmic start${NC}"
echo
echo -e "${CYAN}📖 Get API key: ${BLUE}https://makersuite.google.com/app/apikey${NC}"
echo

# Create desktop shortcut (macOS)
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo -e "${BLUE}🖥️  Creating desktop shortcut...${NC}"
    cat > "$HOME/Desktop/Cosmic AI.command" << EOF
#!/bin/bash
cd "$INSTALL_DIR"
cosmic status
EOF
    chmod +x "$HOME/Desktop/Cosmic AI.command"
    echo -e "${GREEN}✅ Desktop shortcut created!${NC}"
fi

echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Ready to automate your computer with AI! 🤖${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
