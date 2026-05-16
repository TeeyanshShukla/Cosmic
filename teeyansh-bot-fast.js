import TelegramBot from 'node-telegram-bot-api';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TOKEN = '8334100349:AAHPkwSbqW6sioiGjo7NrwgmeXW_MA2A3C4';
const ADMIN_ID = 1394990772;

// Use polling with faster settings
const bot = new TelegramBot(TOKEN, { 
    polling: {
        interval: 300,     // Check every 300ms (was default 1000ms)
        autoStart: true,
        params: { timeout: 10 }
    }
});

console.log('✅ TeeyanshBot FAST MODE - Ready');

const escape = (text) => {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

// Instant response to any command
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    
    if (!text.startsWith('/')) return;
    
    // Log immediately
    console.log(`📨 ${text}`);
    
    if (msg.from.id !== ADMIN_ID) {
        bot.sendMessage(chatId, '❌ Not authorized');
        return;
    }
    
    // Quick acknowledgment
    if (text === '/start') {
        bot.sendMessage(chatId, '🤖 Ready\n/help for commands');
    } 
    else if (text === '/help') {
        bot.sendMessage(chatId, `/find <name>\n/get <path>\n/wakeup\n/screenshot\n/stop`);
    }
    else if (text === '/wakeup') {
        bot.sendMessage(chatId, '⏰ Unlocking...');
        exec('caffeinate -u -t 2 && osascript -e "tell application \\"System Events\\" to keystroke \\"14897\\" & key code 36"', (err) => {
            bot.sendMessage(chatId, err ? '❌ Error' : '✅ Unlocked');
        });
    }
    else if (text === '/screenshot') {
        bot.sendMessage(chatId, '📸 Capturing...');
        const p = path.join(os.tmpdir(), 'screen.png');
        exec(`screencapture -x ${p}`, (err) => {
            if (!err && fs.existsSync(p)) {
                bot.sendPhoto(chatId, p).catch(() => bot.sendMessage(chatId, '❌ Failed'));
            }
        });
    }
    else if (text.startsWith('/find ')) {
        const name = text.replace('/find ', '');
        bot.sendMessage(chatId, `🔍 Searching: ${name}`);
        exec(`find ~ -name "*${name}*" -type f 2>/dev/null | head -5`, (err, out) => {
            bot.sendMessage(chatId, out.trim() || '❌ Not found');
        });
    }
    else if (text.startsWith('/get ')) {
        const filepath = text.replace('/get ', '').trim();
        if (fs.existsSync(filepath)) {
            bot.sendDocument(chatId, filepath).catch(() => bot.sendMessage(chatId, '❌ Error'));
        } else {
            bot.sendMessage(chatId, '❌ File not found');
        }
    }
    else if (text === '/stop') {
        bot.sendMessage(chatId, '⛔ Stopping');
        setTimeout(() => process.exit(0), 500);
    }
});

bot.on('polling_error', (e) => console.error('Poll error:', e.message));
