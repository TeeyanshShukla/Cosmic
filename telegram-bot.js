import TelegramBot from 'node-telegram-bot-api';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TOKEN = '8334100349:AAHPkwSbqW6sioiGjo7NrwgmeXW_MA2A3C4';
const ADMIN_ID = 1394990772;

const bot = new TelegramBot(TOKEN, { 
    polling: {
        interval: 100,
        timeout: 10
    }
});

console.log('✅ TeeyanshBot Started');

const escape = (txt) => String(txt || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

// ============================================
// /START
// ============================================
bot.onText(/\/start/, (msg) => {
    console.log('📨 /start');
    bot.sendMessage(msg.chat.id, '🤖 TeeyanshBot Ready\n\n/help - Show commands').catch(e => {
        console.error('❌ START ERROR:', e.message);
    });
});

// ============================================
// /HELP
// ============================================
bot.onText(/\/help/, (msg) => {
    console.log('📨 /help');
    bot.sendMessage(msg.chat.id, `🤖 **COMMANDS:**
/run <cmd> - Execute
/find <name> - Search files
/get <path> - Download
/wakeup - Wake & unlock
/screenshot - Capture screen
/restart - Restart bot
/stop - Stop bot`, { parse_mode: 'Markdown' }).catch(e => {
        console.error('❌ HELP ERROR:', e.message);
    });
});

// ============================================
// /RUN - Execute command
// ============================================
bot.onText(/\/run (.+)/, (msg, match) => {
    if (msg.from.id !== ADMIN_ID) {
        bot.sendMessage(msg.chat.id, '❌ Not authorized');
        return;
    }
    const cmd = match[1];
    console.log('📨 /run', cmd);
    bot.sendMessage(msg.chat.id, `⏳ Running: ${cmd}`).catch(e => console.error('Error:', e.message));
    
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
        const result = err ? `❌ Error: ${err.message}` : stdout || 'Done';
        bot.sendMessage(msg.chat.id, escape(result)).catch(e => console.error('Error:', e.message));
    });
});

// ============================================
// /FIND - Search files
// ============================================
bot.onText(/\/find (.+)/, (msg, match) => {
    if (msg.from.id !== ADMIN_ID) {
        bot.sendMessage(msg.chat.id, '❌ Not authorized');
        return;
    }
    const name = match[1];
    console.log('📨 /find', name);
    bot.sendMessage(msg.chat.id, `🔍 Searching: ${name}`).catch(e => console.error('Error:', e.message));
    
    exec(`find ~ -name "*${name}*" -type f 2>/dev/null | head -10`, (err, stdout) => {
        const result = stdout.trim() ? `✅ Found:\n${stdout}` : '❌ No files found';
        bot.sendMessage(msg.chat.id, result).catch(e => console.error('Error:', e.message));
    });
});

// ============================================
// /GET - Download file
// ============================================
bot.onText(/\/get (.+)/, (msg, match) => {
    if (msg.from.id !== ADMIN_ID) {
        bot.sendMessage(msg.chat.id, '❌ Not authorized');
        return;
    }
    const filepath = match[1].trim();
    console.log('📨 /get', filepath);
    
    if (!fs.existsSync(filepath)) {
        bot.sendMessage(msg.chat.id, `❌ File not found: ${filepath}`).catch(e => console.error('Error:', e.message));
        return;
    }
    
    bot.sendDocument(msg.chat.id, filepath).catch(e => {
        console.error('❌ GET ERROR:', e.message);
        bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`).catch(() => {});
    });
});

// ============================================
// /WAKEUP - Wake and unlock Mac
// ============================================
bot.onText(/\/wakeup/, (msg) => {
    if (msg.from.id !== ADMIN_ID) {
        bot.sendMessage(msg.chat.id, '❌ Not authorized');
        return;
    }
    console.log('📨 /wakeup');
    bot.sendMessage(msg.chat.id, '⏰ Waking Mac...').catch(e => console.error('Error:', e.message));
    
    exec('caffeinate -u -t 2 && osascript -e "tell application \\"System Events\\" to keystroke \\"14897\\" & key code 36"', (err) => {
        const result = err ? `❌ Error: ${err.message}` : '✅ Mac unlocked';
        bot.sendMessage(msg.chat.id, result).catch(e => console.error('Error:', e.message));
    });
});

// ============================================
// /SCREENSHOT - Take screenshot
// ============================================
bot.onText(/\/screenshot/, (msg) => {
    if (msg.from.id !== ADMIN_ID) {
        bot.sendMessage(msg.chat.id, '❌ Not authorized');
        return;
    }
    console.log('📨 /screenshot');
    bot.sendMessage(msg.chat.id, '📸 Capturing...').catch(e => console.error('Error:', e.message));
    
    const screenshotPath = path.join(os.tmpdir(), 'teeyansh_screenshot.png');
    exec(`screencapture -x ${screenshotPath}`, (err) => {
        if (err) {
            bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`).catch(e => console.error('Error:', e.message));
            return;
        }
        if (fs.existsSync(screenshotPath)) {
            bot.sendPhoto(msg.chat.id, screenshotPath).catch(e => {
                console.error('❌ SCREENSHOT ERROR:', e.message);
                bot.sendMessage(msg.chat.id, `❌ Failed to send: ${e.message}`).catch(() => {});
            });
        }
    });
});

// ============================================
// /RESTART - Restart bot
// ============================================
bot.onText(/\/restart/, (msg) => {
    if (msg.from.id !== ADMIN_ID) {
        bot.sendMessage(msg.chat.id, '❌ Not authorized');
        return;
    }
    console.log('📨 /restart');
    bot.sendMessage(msg.chat.id, '🔄 Restarting...').catch(e => console.error('Error:', e.message));
    
    setTimeout(() => {
        process.exit(0);
    }, 1000);
});

// ============================================
// /STOP - Stop bot
// ============================================
bot.onText(/\/stop/, (msg) => {
    if (msg.from.id !== ADMIN_ID) {
        bot.sendMessage(msg.chat.id, '❌ Not authorized');
        return;
    }
    console.log('📨 /stop');
    bot.sendMessage(msg.chat.id, '⛔ Stopping bot...').catch(e => console.error('Error:', e.message));
    
    setTimeout(() => {
        bot.stopPolling();
        process.exit(0);
    }, 1000);
});

// ============================================
// ERROR HANDLING
// ============================================
bot.on('polling_error', (error) => {
    console.error('❌ POLLING ERROR:', error.message);
});

process.on('uncaughtException', (error) => {
    console.error('❌ EXCEPTION:', error.message);
});

console.log('🟢 Ready - Waiting for messages...');
console.log('Commands: /start, /help, /run, /find, /get, /wakeup, /screenshot, /restart, /stop');
