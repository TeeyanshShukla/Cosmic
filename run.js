#!/usr/bin/env node

import runAgent from "./agent-v3.mjs";
import tools from "./tools.mjs";
import process from "process";

// Colors for terminal output
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

async function executeGoal(goal) {
    console.log(colorize('🤖 AI Computer Agent - Direct Execution', 'cyan'));
    console.log(colorize('═'.repeat(50), 'cyan'));
    console.log(colorize(`🎯 Goal: ${goal}`, 'bright'));
    console.log(colorize('Press Ctrl+C anytime to stop\n', 'yellow'));

    // Take initial screenshot
    await tools.take_screenshot();
    console.log(colorize('📸 Initial screenshot taken', 'blue'));

    let step = 1;
    const maxSteps = 25; // Reasonable limit for complex tasks

    while (step <= maxSteps) {
        console.log(colorize(`\n━━━ Step ${step} ━━━`, 'magenta'));

        try {
            const result = await runAgent(goal);

            if (result.success) {
                const action = result.actionPlan.action;
                const args = result.actionPlan.args;

                console.log(colorize(`✅ Action: ${action}`, 'green'));
                console.log(colorize(`   Args: ${JSON.stringify(args)}`, 'blue'));

                // Add contextual delays based on action type
                if (action === 'key_combo' && args.keys === 'LeftCmd+Space') {
                    console.log(colorize('⏳ Waiting for Spotlight to open...', 'yellow'));
                    await new Promise(r => setTimeout(r, 1500));
                } else if (action === 'key_combo' && args.keys === 'cmd+b') {
                    console.log(colorize('⏳ Opening in Chrome browser...', 'yellow'));
                    await new Promise(r => setTimeout(r, 2000));
                } else if (action === 'type') {
                    console.log(colorize('⏳ Waiting for typing to complete...', 'yellow'));
                    await new Promise(r => setTimeout(r, 1000));
                } else if (action === 'enter') {
                    console.log(colorize('⏳ Waiting for action to process...', 'yellow'));
                    await new Promise(r => setTimeout(r, 2000));
                } else if (action === 'click') {
                    console.log(colorize('⏳ Waiting for click response...', 'yellow'));
                    await new Promise(r => setTimeout(r, 1500));
                } else {
                    await new Promise(r => setTimeout(r, 800));
                }

            } else {
                console.log(colorize('❌ Action failed, continuing...', 'red'));
                await new Promise(r => setTimeout(r, 1000));
            }

        } catch (error) {
            console.error(colorize(`💥 Error in step ${step}:`, 'red'), error.message);
            await new Promise(r => setTimeout(r, 1000));
        }

        step++;
    }

    if (step > maxSteps) {
        console.log(colorize(`\n⏰ Reached maximum steps (${maxSteps})`, 'yellow'));
    }

    console.log(colorize('\n🏁 Execution completed!', 'green'));
    console.log(colorize(`📊 Total steps: ${step - 1}`, 'cyan'));
}

// Handle command line arguments
const args = process.argv.slice(2);

if (args.length === 0) {
    console.log(colorize('🤖 AI Computer Agent - Command Line Interface', 'cyan'));
    console.log(colorize('\nUsage:', 'bright'));
    console.log(colorize('  node run.js "your goal here"', 'yellow'));
    console.log(colorize('\nExamples:', 'bright'));
    console.log(colorize('  node run.js "open Spotify and search for Yoyo Honey Singh"', 'green'));
    console.log(colorize('  node run.js "open Chrome and go to YouTube"', 'green'));
    console.log(colorize('  node run.js "take a screenshot and open Calculator"', 'green'));
    console.log(colorize('\nFeatures:', 'bright'));
    console.log(colorize('• Always moves mouse before clicking', 'blue'));
    console.log(colorize('• Verifies app context before actions', 'blue'));
    console.log(colorize('• Uses LeftCmd+Space for Spotlight search', 'blue'));
    console.log(colorize('• Confirms each action before proceeding', 'blue'));
    process.exit(1);
}

const goal = args.join(' ');

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
    console.log(colorize('\n\n🛑 Execution stopped by user', 'yellow'));
    console.log(colorize('👋 Goodbye!', 'cyan'));
    process.exit(0);
});

// Execute the goal
executeGoal(goal).catch((error) => {
    console.error(colorize('\n💥 Fatal error:', 'red'), error.message);
    process.exit(1);
});