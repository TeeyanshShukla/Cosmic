import TelegramBot from 'node-telegram-bot-api';

const TOKEN = '8334100349:AAHPkwSbqW6sioiGjo7NrwgmeXW_MA2A3C4';
const ADMIN_ID = 1394990772;

console.log('🔧 DEBUG: Initializing bot with token...');

try {
    const bot = new TelegramBot(TOKEN, { polling: true });
    
    console.log('✅ DEBUG: Bot initialized');
    
    bot.on('message', (msg) => {
        console.log(`📨 DEBUG: Received message: "${msg.text}" from ${msg.from.id}`);
        
        if (msg.from.id === ADMIN_ID) {
            bot.sendMessage(msg.chat.id, `✅ ECHO: ${msg.text}`);
            console.log('✅ DEBUG: Response sent');
        }
    });
    
    bot.on('polling_error', (error) => {
        console.error('❌ DEBUG: Polling error:', error.message);
    });
    
    console.log('🟢 DEBUG: Bot waiting for messages...');
    
} catch (error) {
    console.error('❌ DEBUG: Error:', error.message);
}
