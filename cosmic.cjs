#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LABEL = 'com.cosmicai.telegram-bot';
const PROJECT_DIR = process.cwd();
const START_SCRIPT = path.join(PROJECT_DIR, 'start_bot.sh');
const STOP_SCRIPT = path.join(PROJECT_DIR, 'stop_bot.sh');
const LOG_FILE = path.join(PROJECT_DIR, 'bot.log');
const MONITOR_LOG = path.join(PROJECT_DIR, 'bot-monitor.log');
const LAUNCHD_LOG = path.join(PROJECT_DIR, 'launchd-bot.log');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function c(text, color) {
  return `${colors[color] || ''}${text}${colors.reset}`;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    stdio: opts.stdio || 'pipe',
    cwd: opts.cwd || PROJECT_DIR,
    encoding: 'utf8',
  });
}

function printHelp() {
  console.log(`\nCosmic CLI\n\nUsage:\n  cosmic <command>\n\nCommands:\n  start        Start Cosmic bot monitor\n  stop         Stop Cosmic bot monitor and bot process\n  restart      Restart Cosmic services\n  status       Show launchd + process status\n  logs         Tail logs (launchd -> monitor -> bot)\n  doctor       Validate dependencies and config\n  setup        Run setup wizard\n  install      Install launchd auto-start\n  uninstall    Remove launchd auto-start\n  help         Show this help\n`);
}

function ensureScript(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(c(`Missing script: ${filePath}`, 'red'));
    process.exit(1);
  }
}

function start() {
  ensureScript(START_SCRIPT);
  const result = run('bash', [START_SCRIPT], { stdio: 'inherit' });
  process.exit(result.status || 0);
}

function stop() {
  ensureScript(STOP_SCRIPT);
  const result = run('bash', [STOP_SCRIPT], { stdio: 'inherit' });
  process.exit(result.status || 0);
}

function restart() {
  ensureScript(STOP_SCRIPT);
  ensureScript(START_SCRIPT);
  run('bash', [STOP_SCRIPT], { stdio: 'inherit' });
  const result = run('bash', [START_SCRIPT], { stdio: 'inherit' });
  process.exit(result.status || 0);
}

function status() {
  const launchd = run('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]);
  const monitor = run('pgrep', ['-f', '/start_bot.sh']);
  const bot = run('pgrep', ['-f', 'node telegram-bot-fixed-v2.js']);

  console.log('\nCosmic Status');
  console.log('-------------');
  console.log(launchd.status === 0 ? c('launchd: active', 'green') : c('launchd: not loaded', 'yellow'));
  console.log(monitor.status === 0 ? c('monitor: running', 'green') : c('monitor: not running', 'yellow'));
  console.log(bot.status === 0 ? c('telegram bot: running', 'green') : c('telegram bot: not running', 'yellow'));

  if (launchd.status !== 0 && monitor.status !== 0 && bot.status !== 0) {
    process.exit(1);
  }
}

function tailLogs() {
  const files = [LAUNCHD_LOG, MONITOR_LOG, LOG_FILE].filter((f) => fs.existsSync(f));
  if (files.length === 0) {
    console.log(c('No log files found yet. Start Cosmic first with `cosmic start`.', 'yellow'));
    return;
  }

  console.log(c(`Tailing logs: ${files.join(', ')}`, 'cyan'));
  const result = run('tail', ['-n', '80', '-f', ...files], { stdio: 'inherit' });
  process.exit(result.status || 0);
}

function doctor() {
  const issues = [];

  const node = run('node', ['-v']);
  if (node.status !== 0) {
    issues.push('Node.js is not available in PATH.');
  } else {
    console.log(c(`node: ${node.stdout.trim()}`, 'green'));
  }

  const npm = run('npm', ['-v']);
  if (npm.status !== 0) {
    issues.push('npm is not available in PATH.');
  } else {
    console.log(c(`npm: ${npm.stdout.trim()}`, 'green'));
  }

  const envPath = path.join(PROJECT_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    issues.push('.env file is missing. Run `cosmic setup`.');
  } else {
    const envContent = fs.readFileSync(envPath, 'utf8');
    if (!/GEMINI_API_KEY\s*=\s*.+/m.test(envContent) || envContent.includes('your-api-key-here')) {
      issues.push('GEMINI_API_KEY is not configured in .env.');
    } else {
      console.log(c('.env: present with GEMINI_API_KEY', 'green'));
    }
    if (!/TELEGRAM_BOT_TOKEN\s*=\s*.+/m.test(envContent)) {
      issues.push('TELEGRAM_BOT_TOKEN is missing in .env.');
    } else {
      console.log(c('.env: TELEGRAM_BOT_TOKEN configured', 'green'));
    }
    if (!/TELEGRAM_ADMIN_ID\s*=\s*.+/m.test(envContent)) {
      issues.push('TELEGRAM_ADMIN_ID is missing in .env.');
    } else {
      console.log(c('.env: TELEGRAM_ADMIN_ID configured', 'green'));
    }
  }

  const required = ['telegram-bot-fixed-v2.js', 'start_bot.sh', 'stop_bot.sh', 'install_bot_autostart.sh'];
  required.forEach((f) => {
    if (!fs.existsSync(path.join(PROJECT_DIR, f))) {
      issues.push(`Missing required file: ${f}`);
    }
  });

  if (issues.length > 0) {
    console.log(c('\nDoctor found issues:', 'red'));
    for (const issue of issues) {
      console.log(`- ${issue}`);
    }
    process.exit(1);
  }

  console.log(c('\nDoctor check passed. Cosmic is ready.', 'green'));
}

function setup() {
  const result = run('node', [path.join(PROJECT_DIR, 'setup.js')], { stdio: 'inherit' });
  process.exit(result.status || 0);
}

function installAutostart() {
  const result = run('bash', [path.join(PROJECT_DIR, 'install_bot_autostart.sh')], { stdio: 'inherit' });
  process.exit(result.status || 0);
}

function uninstallAutostart() {
  const result = run('bash', [path.join(PROJECT_DIR, 'uninstall_bot_autostart.sh')], { stdio: 'inherit' });
  process.exit(result.status || 0);
}

const cmd = process.argv[2] || 'help';

switch (cmd) {
  case 'start':
    start();
    break;
  case 'stop':
    stop();
    break;
  case 'restart':
    restart();
    break;
  case 'status':
    status();
    break;
  case 'logs':
    tailLogs();
    break;
  case 'doctor':
    doctor();
    break;
  case 'setup':
    setup();
    break;
  case 'install':
    installAutostart();
    break;
  case 'uninstall':
    uninstallAutostart();
    break;
  case 'help':
  default:
    printHelp();
    break;
}
