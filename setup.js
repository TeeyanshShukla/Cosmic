#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Colors for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function colorize(text, color) {
    return `${colors[color]}${text}${colors.reset}`;
}

function showWelcome() {
    console.clear();
    console.log(colorize('╔══════════════════════════════════════════════════════════════╗', 'cyan'));
    console.log(colorize('║                    🤖 AI COMPUTER AGENT                     ║', 'cyan'));
    console.log(colorize('║                        SETUP WIZARD                         ║', 'cyan'));
    console.log(colorize('╚══════════════════════════════════════════════════════════════╝', 'cyan'));
    console.log();
}

function checkNodeVersion() {
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
    
    console.log(colorize('🔍 Checking Node.js version...', 'yellow'));
    
    if (majorVersion >= 16) {
        console.log(colorize(`✅ Node.js ${nodeVersion} - Compatible!`, 'green'));
        return true;
    } else {
        console.log(colorize(`❌ Node.js ${nodeVersion} - Need version 16 or higher`, 'red'));
        console.log(colorize('Please update Node.js: https://nodejs.org/', 'yellow'));
        return false;
    }
}

function checkDependencies() {
    console.log(colorize('\n📦 Checking dependencies...', 'yellow'));
    
    const packagePath = path.join(__dirname, 'package.json');
    if (!fs.existsSync(packagePath)) {
        console.log(colorize('❌ package.json not found!', 'red'));
        return false;
    }
    
    const nodeModulesPath = path.join(__dirname, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
        console.log(colorize('❌ Dependencies not installed!', 'red'));
        console.log(colorize('Run: npm install', 'yellow'));
        return false;
    }
    
    console.log(colorize('✅ Dependencies installed', 'green'));
    return true;
}

function setupApiKey() {
    console.log(colorize('\n🔑 Setting up API key...', 'yellow'));
    
    const envPath = path.join(__dirname, '.env');
    
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        if (!envContent.includes('your-api-key-here')) {
            console.log(colorize('✅ API key already configured', 'green'));
            return true;
        }
    }
    
    // Create .env file with placeholder
    const envContent = [
        'GEMINI_API_KEY="your-api-key-here"',
        'TELEGRAM_BOT_TOKEN=""',
        'TELEGRAM_ADMIN_ID=""'
    ].join('\n');
    fs.writeFileSync(envPath, envContent);
    
    console.log(colorize('📝 Created .env file', 'green'));
    console.log(colorize('\n🚨 IMPORTANT: You need to add your Gemini API key!', 'red'));
    console.log(colorize('\nSteps:', 'cyan'));
    console.log(colorize('1. Go to: https://makersuite.google.com/app/apikey', 'blue'));
    console.log(colorize('2. Create a new API key', 'blue'));
    console.log(colorize('3. Copy the key', 'blue'));
    console.log(colorize('4. Edit .env file and replace "your-api-key-here" with your key', 'blue'));
    
    return false; // Need manual API key setup
}

function checkPermissions() {
    console.log(colorize('\n🔒 Checking permissions...', 'yellow'));
    
    const platform = process.platform;
    
    if (platform === 'darwin') {
        console.log(colorize('📱 macOS detected', 'blue'));
        console.log(colorize('\n⚠️  You may need to grant permissions:', 'yellow'));
        console.log(colorize('1. Screen Recording: System Preferences → Security & Privacy → Screen Recording', 'cyan'));
        console.log(colorize('2. Accessibility: System Preferences → Security & Privacy → Accessibility', 'cyan'));
        console.log(colorize('3. Add Terminal (or your terminal app) to both lists', 'cyan'));
    } else if (platform === 'win32') {
        console.log(colorize('🪟 Windows detected', 'blue'));
        console.log(colorize('✅ No special permissions needed', 'green'));
    } else {
        console.log(colorize('🐧 Linux detected', 'blue'));
        console.log(colorize('✅ No special permissions needed', 'green'));
    }
    
    return true;
}

function showNextSteps() {
    console.log(colorize('\n🎯 Next Steps:', 'cyan'));
    console.log(colorize('1. Configure your API key in .env file', 'yellow'));
    console.log(colorize('2. Grant necessary permissions (if on macOS)', 'yellow'));
    console.log(colorize('3. Add TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_ID in .env', 'yellow'));
    console.log(colorize('4. Run: cosmic install && cosmic start', 'yellow'));
    
    console.log(colorize('\n🚀 Quick Commands:', 'cyan'));
    console.log(colorize('• cosmic doctor      - Validate config and dependencies', 'blue'));
    console.log(colorize('• cosmic install     - Enable auto-start via launchd', 'blue'));
    console.log(colorize('• cosmic start       - Start Telegram polling monitor', 'blue'));
    console.log(colorize('• cosmic logs        - Tail runtime logs', 'blue'));
}

function main() {
    showWelcome();
    
    let allGood = true;
    
    // Check Node.js version
    if (!checkNodeVersion()) {
        allGood = false;
    }
    
    // Check dependencies
    if (!checkDependencies()) {
        allGood = false;
    }
    
    // Setup API key
    if (!setupApiKey()) {
        allGood = false;
    }
    
    // Check permissions
    checkPermissions();
    
    console.log(colorize('\n' + '═'.repeat(60), 'cyan'));
    
    if (allGood) {
        console.log(colorize('🎉 Setup Complete! Ready to use AI Computer Agent', 'green'));
    } else {
        console.log(colorize('⚠️  Setup needs attention - see messages above', 'yellow'));
    }
    
    showNextSteps();
    
    console.log(colorize('\n💡 Need help? Check README.md for detailed instructions', 'cyan'));
    console.log(colorize('═'.repeat(60), 'cyan'));
}

main();
