/**
 * 🤖 TeeyanshBot - Fast Telegram Bot
 * Bot: @TeeyanshBot
 * Admin: 1394990772
 */

import TelegramBot from 'node-telegram-bot-api';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TOKEN = '8334100349:AAHPkwSbqW6sioiGjo7NrwgmeXW_MA2A3C4';
const ADMIN_ID = 1394990772;

const bot = new TelegramBot(TOKEN, { polling: true });

console.log('✅ TeeyanshBot Started');

const escape = (text) => {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

function isAdmin(msg) {
    return msg.from.id === ADMIN_ID;
}

// ============================================
// START
// ============================================
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '🤖 TeeyanshBot Ready\n\n/help for commands', { parse_mode: 'Markdown' });
});

// ============================================
// HELP
// ============================================
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `🤖 **Commands:**
/find <name> - Search files
/get <path> - Download
/wakeup - Wake Mac
/screenshot - Capture
/restart - Restart
/stop - Stop bot`, { parse_mode: 'Markdown' });
});

// ============================================
// FIND - Non-blocking
// ============================================
bot.onText(/\/find (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg)) return bot.sendMessage(chatId, '❌ Not auth');

    const filename = match[1];
    bot.sendMessage(chatId, `🔍 Searching: ${filename}`);

    exec(`find ~ -name "*${filename}*" -type f 2>/dev/null | head -10`, (err, stdout) => {
        if (err || !stdout.trim()) {
            bot.sendMessage(chatId, '❌ No files found');
            return;
        }
        const files = stdout.trim().split('\n').map((f, i) => `${i+1}. ${f}`).join('\n');
        bot.sendMessage(chatId, `✅ Found:\n\n${files}`);
    });
});

// ============================================
// GET - Non-blocking
// ============================================
bot.onText(/\/get (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg)) return bot.sendMessage(chatId, '❌ Not auth');

    const filepath = match[1].trim();
    
    if (!fs.existsSync(filepath)) {
        bot.sendMessage(chatId, '❌ File not found');
        return;
    }

    const stats = fs.statSync(filepath);
    if (stats.size > 100 * 1024 * 1024) {
        bot.sendMessage(chatId, '❌ File too large');
        return;
    }

    bot.sendDocument(chatId, filepath).catch(err => {
        bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    });
});

// ============================================
// WAKEUP - Non-blocking
// ============================================
bot.onText(/\/wakeup/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg)) return bot.sendMessage(chatId, '❌ Not auth');

    bot.sendMessage(chatId, '⏰ Waking Mac...');

    exec('caffeinate -u -t 2 && osascript -e "tell application \\"System Events\\" to keystroke \\"14897\\" & key code 36"', (err) => {
        if (err) {
            bot.sendMessage(chatId, `❌ Error`);
        } else {
            bot.sendMessage(chatId, '✅ Mac unlocked');
        }
    });
});

// ============================================
// SCREENSHOT - Non-blocking
// ============================================
bot.onText(/\/screenshot/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg)) return bot.sendMessage(chatId, '❌ Not auth');

    bot.sendMessage(chatId, '📸 Capturing...');

    const screenshotPath = path.join(os.tmpdir(), 'screen.png');
    exec(`screencapture -x ${screenshotPath}`, (err) => {
        if (!err && fs.existsSync(screenshotPath)) {
            bot.sendPhoto(chatId, screenshotPath).catch(e => {
                bot.sendMessage(chatId, '❌ Screenshot failed');
            });
        } else {
            bot.sendMessage(chatId, '❌ Screenshot failed');
        }
    });
});

// ============================================
// RESTART
// ============================================
bot.onText(/\/restart/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg)) return bot.sendMessage(chatId, '❌ Not auth');

    bot.sendMessage(chatId, '🔄 Restarting...');
    setTimeout(() => process.exit(0), 500);
});

// ============================================
// STOP
// ============================================
bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg)) return bot.sendMessage(chatId, '❌ Not auth');

    bot.sendMessage(chatId, '⛔ Stopping bot...');
    setTimeout(() => {
        bot.stopPolling();
        process.exit(0);
    }, 500);
});

bot.on('polling_error', (error) => {
    console.error('Poll error:', error.message);
});

console.log('🟢 TeeyanshBot is ready');
