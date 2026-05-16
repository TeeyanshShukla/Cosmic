#!/usr/bin/env node

import runAgent from "./agent-v3.mjs";
import tools from "./tools.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🎨 CLI Colors
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

function colorize(text, color) {
    return `${colors[color]}${text}${colors.reset}`;
}

// 🔧 Setup functions
function checkApiKey() {
    const envPath = path.join(__dirname, '.env');

    if (!fs.existsSync(envPath)) {
        console.log(colorize('\n❌ No .env file found!', 'red'));
        console.log(colorize('Creating .env file...', 'yellow'));

        const envContent = 'GEMINI_API_KEY="your-api-key-here"';
        fs.writeFileSync(envPath, envContent);

        console.log(colorize('\n📝 Please edit .env file and add your Gemini API key:', 'cyan'));
        console.log(colorize('GEMINI_API_KEY="your-actual-api-key"', 'yellow'));
        console.log(colorize('\nGet your API key from: https://makersuite.google.com/app/apikey', 'blue'));
        process.exit(1);
    }

    try {
        const envContent = fs.readFileSync(envPath, 'utf8');
        if (!envContent.trim() || envContent.includes('your-api-key-here') || !process.env.GEMINI_API_KEY) {
            console.log(colorize('\n❌ Please set your actual Gemini API key in .env file!', 'red'));
            console.log(colorize('Edit .env and replace "your-api-key-here" with your actual API key', 'yellow'));
            process.exit(1);
        }
    } catch (e) {
        console.error(colorize(`\n❌ Error reading .env file: ${e.message}`, 'red'));
        process.exit(1);
    }

    console.log(colorize('✅ API key configured', 'green'));
}

function showWelcome() {
    console.clear();
    console.log(colorize('╔══════════════════════════════════════════════════════════════╗', 'cyan'));
    console.log(colorize('║                    🤖 COMPUTER USE AGENT                     ║', 'cyan'));
    console.log(colorize('║                                                              ║', 'cyan'));
    console.log(colorize('║  AI-powered computer automation using Gemini 2.5 Pro       ║', 'cyan'));
    console.log(colorize('║  Controls mouse, keyboard, and screen interactions          ║', 'cyan'));
    console.log(colorize('╚══════════════════════════════════════════════════════════════╝', 'cyan'));
    console.log();
}

function showMenu() {
    console.log(colorize('\n📋 Choose an option:', 'bright'));
    console.log(colorize('1. 🎯 Run with custom goal', 'yellow'));
    console.log(colorize('2. 🎬 Run demo (safe actions)', 'yellow'));
    console.log(colorize('3. 🎵 Spotify demo (Yoyo Honey Singh search)', 'yellow'));
    console.log(colorize('4. ⌨️  Test keyboard functions', 'yellow'));
    console.log(colorize('5. 🖱️  Test mouse functions', 'yellow'));
    console.log(colorize('6. ⚙️  Settings', 'yellow'));
    console.log(colorize('7. ❌ Exit', 'yellow'));
    console.log();
}


async function runCustomGoal() {
    const readline = await import('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question(colorize('🎯 Enter your goal: ', 'cyan'), async (goal) => {
            rl.close();

            if (!goal.trim()) {
                console.log(colorize('❌ Goal cannot be empty!', 'red'));
                resolve();
                return;
            }

            console.log(colorize(`\n🚀 Starting agent with goal: "${goal}"`, 'green'));
            console.log(colorize('Press Ctrl+C to stop\n', 'yellow'));

            await tools.take_screenshot();

            let iterations = 0;
            const maxIterations = 2001;

            while (iterations < maxIterations) {
                console.log(colorize(`\n━━━ Step ${iterations + 1} ━━━`, 'magenta'));

                try {
                    const result = await runAgent(goal);

                    if (result.stop === true) {
                        console.log(colorize('🎉 Task completed successfully!', 'green'));
                        break;  // EXIT LOOP
                    }

                    if (result.success) {
                        console.log(colorize('✅ Action executed', 'green'));
                    } else {
                        console.log(colorize('❌ Action failed', 'red'));
                    }

                    iterations++;
                    await new Promise(r => setTimeout(r, 1000));

                } catch (error) {
                    console.error(colorize('💥 Error:', 'red'), error.message);
                    break;
                }
            }

            console.log(colorize('\n🏁 Agent finished', 'green'));
            resolve();
        });
    });
}

async function runDemo() {
    console.log(colorize('\n🎬 Running safe demo...', 'green'));

    const demoActions = [
        "Move mouse to center of screen",
        "Wait for 1 second",
        "Move mouse to coordinates 200, 200",
        "Wait for 1 second"
    ];

    await tools.take_screenshot();

    for (let i = 0; i < demoActions.length; i++) {
        const action = demoActions[i];
        console.log(colorize(`\n🎯 Demo ${i + 1}: ${action}`, 'cyan'));

        try {
            const result = await runAgent(action);

            if (result.success) {
                console.log(colorize('✅ Success!', 'green'));
            } else {
                console.log(colorize('❌ Failed', 'red'));
            }

            await new Promise(r => setTimeout(r, 1000));

        } catch (error) {
            console.error(colorize('💥 Error:', 'red'), error.message);
        }
    }

    console.log(colorize('\n🎉 Demo completed!', 'green'));
}

async function runSpotifyDemo() {
    console.log(colorize('\n🎵 Running Smart Spotify Demo...', 'green'));
    console.log(colorize('This will:', 'cyan'));
    console.log(colorize('1. Look for Spotify in dock first', 'yellow'));
    console.log(colorize('2. Use Spotlight if not in dock', 'yellow'));
    console.log(colorize('3. Fall back to Chrome web version if needed', 'yellow'));
    console.log(colorize('4. Search for Yoyo Honey Singh', 'yellow'));
    console.log(colorize('5. Play the first track found', 'yellow'));

    console.log(colorize('\n⚠️  Make sure you have either:', 'yellow'));
    console.log(colorize('• Spotify app installed, OR', 'cyan'));
    console.log(colorize('• Chrome browser for web version', 'cyan'));

    await tools.take_screenshot();

    try {
        // Simple Spotify demo using the agent
        const goal = "Open Spotify and search for Yoyo Honey Singh, then play the first track";
        console.log(colorize(`\n🚀 Starting goal: "${goal}"`, 'green'));

        const result = await runAgent(goal);

        if (result.success) {
            console.log(colorize('✅ Spotify demo completed!', 'green'));
        } else {
            console.log(colorize('❌ Spotify demo failed', 'red'));
        }
    } catch (error) {
        console.error(colorize('💥 Spotify demo error:', 'red'), error.message);
    }
}

async function testKeyboard() {
    console.log(colorize('\n⌨️ Testing keyboard functions...', 'green'));
    console.log(colorize('⚠️  Make sure you have a text editor open!', 'yellow'));

    const keyboardTests = [
        "Type 'Hello from AI Agent!'",
        "Press Enter key",
        "Type 'Testing keyboard functions'",
        "Press Tab key"
    ];

    await tools.take_screenshot();

    for (let i = 0; i < keyboardTests.length; i++) {
        const test = keyboardTests[i];
        console.log(colorize(`\n⌨️ Test ${i + 1}: ${test}`, 'cyan'));

        try {
            const result = await runAgent(test);

            if (result.success) {
                console.log(colorize('✅ Success!', 'green'));
            } else {
                console.log(colorize('❌ Failed', 'red'));
            }

            await new Promise(r => setTimeout(r, 1500));

        } catch (error) {
            console.error(colorize('💥 Error:', 'red'), error.message);
        }
    }

    console.log(colorize('\n🎉 Keyboard tests completed!', 'green'));
}

async function testMouse() {
    console.log(colorize('\n🖱️ Testing mouse functions...', 'green'));

    const mouseTests = [
        "Move mouse to coordinates 400, 300",
        "Move mouse to coordinates 600, 400",
        "Move mouse to center of screen",
        "Wait for 2 seconds"
    ];

    await tools.take_screenshot();

    for (let i = 0; i < mouseTests.length; i++) {
        const test = mouseTests[i];
        console.log(colorize(`\n🖱️ Test ${i + 1}: ${test}`, 'cyan'));

        try {
            const result = await runAgent(test);

            if (result.success) {
                console.log(colorize('✅ Success!', 'green'));
            } else {
                console.log(colorize('❌ Failed', 'red'));
            }

            await new Promise(r => setTimeout(r, 1000));

        } catch (error) {
            console.error(colorize('💥 Error:', 'red'), error.message);
        }
    }

    console.log(colorize('\n🎉 Mouse tests completed!', 'green'));
}

function showSettings() {
    console.log(colorize('\n⚙️ Settings:', 'cyan'));
    console.log(colorize('• API Key: Configured ✅', 'green'));
    console.log(colorize('• Model: Gemini 2.5 Pro (Planner)', 'blue'));
    console.log(colorize('• Architecture: Planner → Direct Executor', 'blue'));
    console.log(colorize('\n🛠️ Available Tools:', 'cyan'));
    console.log(colorize('• Mouse: move, click, scroll', 'yellow'));
    console.log(colorize('• Keyboard: type, enter, tab, escape, backspace, space', 'yellow'));
    console.log(colorize('• Key combinations: cmd+c, ctrl+v, etc.', 'yellow'));
    console.log(colorize('• System: wait, take_screenshot', 'yellow'));
}

async function main() {
    showWelcome();
    checkApiKey();

    const readline = await import('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const askQuestion = (question) => new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer.trim());
        });
    });

    while (true) {
        showMenu();

        const choice = await askQuestion(colorize('Enter your choice (1-7): ', 'bright'));

        switch (choice) {
            case '1':
                await runCustomGoal();
                break;
            case '2':
                await runDemo();
                break;
            case '3':
                await runSpotifyDemo();
                break;
            case '4':
                await testKeyboard();
                break;
            case '5':
                await testMouse();
                break;

            case '6':
                showSettings();
                break;
            case '7':
                console.log(colorize('\n👋 Goodbye!', 'cyan'));
                rl.close();
                process.exit(0);
            default:
                console.log(colorize('\n❌ Invalid choice. Please enter 1-7.', 'red'));
        }

        await askQuestion(colorize('\nPress Enter to continue...', 'yellow'));
    }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
    console.log(colorize('\n\n👋 Agent stopped by user. Goodbye!', 'cyan'));
    process.exit(0);
});

main().catch((error) => {
    console.error(colorize('\n❌ Fatal error:', 'red'), error.message);
    console.error(error.stack);
    process.exit(1);
});