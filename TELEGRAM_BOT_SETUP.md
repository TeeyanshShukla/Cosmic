# 🤖 Telegram Bot Setup Guide

## Step 1: Create Telegram Bot with BotFather

1. Open Telegram and search for **@BotFather**
2. Start a conversation and send: `/newbot`
3. Choose a name (e.g., "My AI Agent")
4. Choose a username (e.g., "my_ai_agent_bot")
5. **Copy the token** that looks like: `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`

## Step 2: Get Your User ID

1. Search for **@userinfobot** on Telegram
2. Start a conversation - it will show your User ID
3. **Copy your User ID** (a number like `123456789`)

## Step 3: Update Environment File

Edit `.env` in your project:

```bash
# Replace with your actual bot token
TELEGRAM_BOT_TOKEN="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"

# Replace with your User ID (you can add multiple comma-separated)
TELEGRAM_ADMIN_IDS="123456789,987654321"
```

## Step 4: Run the Bot

```bash
# From your computer-use-agent directory
node telegram-bot.js
```

You should see:
```
✅ Telegram Bot is running!
📝 Waiting for commands...
```

## Step 5: Test Commands

Open Telegram and message your bot:

### Command Examples:

**1. Run Agent Command**
```
/run Search on Google: What is AI
```

**2. Find Files**
```
/find AI_Notes
```

**3. Get AI Notes** (Auto-search)
```
/notes
```

**4. Download File**
```
/get /path/to/file.txt
```

**5. Take Screenshot**
```
/screenshot
```

**6. Get Help**
```
/help
```

---

## 📋 Available Commands

| Command | Usage | Example |
|---------|-------|---------|
| `/run` | Execute agent task | `/run Open Safari and search AI` |
| `/find` | Search for files | `/find notes.txt` |
| `/get` | Download file to Telegram | `/get /Users/you/Documents/notes.txt` |
| `/notes` | Auto-find and send AI notes | `/notes` |
| `/screenshot` | Capture current screen | `/screenshot` |
| `/help` | Show all commands | `/help` |
| `/start` | Welcome message | `/start` |

---

## 🔒 Security Features

✅ **Admin-only access** - Only users in `TELEGRAM_ADMIN_IDS` can execute commands
✅ **Path validation** - Can only access files in home directory
✅ **File size limits** - Max 100MB per file (Telegram limit)
✅ **Authorization checks** - Every command requires authentication

---

## 🔄 Keep Bot Running 24/7 (Optional)

### Option 1: Run in Background
```bash
nohup node telegram-bot.js > telegram-bot.log 2>&1 &
```

### Option 2: Use PM2 (Recommended)
```bash
npm install -g pm2
pm2 start telegram-bot.js --name "ai-agent-bot"
pm2 save
pm2 startup
```

Check status:
```bash
pm2 status
```

---

## 🐛 Troubleshooting

**"TELEGRAM_BOT_TOKEN not set"**
- Make sure you updated `.env` with your real token

**"Not authorized"**
- Your User ID doesn't match `TELEGRAM_ADMIN_IDS`
- Run `/start` on the bot to see your User ID

**Bot doesn't respond**
- Check if bot is still running: `ps aux | grep telegram-bot`
- Check logs: `tail -f telegram-bot.log`

**File not found**
- Make sure full file path is correct
- Use `/find filename` to get the exact path

---

## 📱 Common Workflows

### Workflow 1: Remote Task Execution
```
You:  /run Open Spotify and search "Yoyo Honey Singh"
Bot:  ⏳ Executing...
Bot:  ✅ Task completed successfully!
```

### Workflow 2: Get AI Notes
```
You:  /notes
Bot:  ✅ Found 3 note file(s): ...
Bot:  📄 AI_Notes.md
Bot:  📄 Research.pdf
Bot:  📄 Ideas.txt
```

### Workflow 3: Find & Download Specific File
```
You:  /find important_document
Bot:  ✅ Found 2 file(s):
Bot:  1. /Users/you/Documents/important_document.pdf
Bot:  Use: /get <file_path>

You:  /get /Users/you/Documents/important_document.pdf
Bot:  📤 Sending: important_document.pdf (2.5 MB)
Bot:  📄 important_document.pdf (sent)
```

---

## 🎯 Next Steps

1. ✅ Get bot token from BotFather
2. ✅ Get your User ID from userinfobot
3. ✅ Update `.env` file
4. ✅ Run `node telegram-bot.js`
5. ✅ Test commands in Telegram
6. ✅ (Optional) Set up PM2 for 24/7 running

---

## 💡 Tips

- You can add multiple admin users: `TELEGRAM_ADMIN_IDS="123,456,789"`
- Files are sent via Telegram's document feature (encrypted)
- Agent commands run with full access to your computer
- Screenshots are taken from your current desktop

**Enjoy remote control of your AI Agent! 🚀**
