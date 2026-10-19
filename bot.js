const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');
const { downloadScribdDocument } = require('./downloader');

// Load environment variables
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error('❌ Please set your BOT_TOKEN in .env file!');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let botUsername = 'ScribdPdfDownloaderBot';
bot.getMe().then(me => {
  botUsername = me.username || botUsername;
  console.log(`🤖 Bot is active as: @${botUsername}`);
}).catch(err => {
  console.warn('Bot info fetch warning:', err.message);
});

console.log('🚀 Scribd HD PDF Downloader Engine initialized.');

// Helper: Extract Scribd Document ID
function extractScribdDocId(text) {
  if (!text) return null;
  let match = text.match(/scribd\.com\/(?:document|doc|presentation|embeds)\/(\d+)/i);
  if (match) return match[1];

  match = text.match(/[?&]doc_id=(\d+)/i);
  if (match) return match[1];

  const trimmed = text.trim();
  if (/^\d{6,12}$/.test(trimmed)) return trimmed;

  return null;
}

// Generate sleek Unicode progress bar: [████░░░░░░]
function getProgressBar(percent) {
  const total = 10;
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * total);
  return '█'.repeat(filled) + '░'.repeat(total - filled);
}

// Format duration
function formatSeconds(sec) {
  return `${sec.toFixed(1)}s`;
}

// -------------------------------------------------------------
// Auto-deletion: Keep PDFs for 30 minutes, then automatically remove
// -------------------------------------------------------------
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
function cleanOldDownloads() {
  const downloadsDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadsDir)) return;
  const now = Date.now();
  fs.readdir(downloadsDir, (err, files) => {
    if (err) return;
    for (const file of files) {
      if (!file.endsWith('.pdf')) continue;
      const filePath = path.join(downloadsDir, file);
      fs.stat(filePath, (err, stats) => {
        if (!err && (now - stats.mtimeMs) > THIRTY_MINUTES_MS) {
          fs.unlink(filePath, () => {
            console.log(`🧹 [30m Expiry] Deleted old PDF cache: ${file}`);
          });
        }
      });
    }
  });
}
// Run cleaner at startup and every 3 minutes
cleanOldDownloads();
setInterval(cleanOldDownloads, 3 * 60 * 1000);

// -------------------------------------------------------------
// HTTP Server: Serves files > 50MB via direct high-speed download link
// -------------------------------------------------------------
function getPublicDownloadUrl(filePath) {
  const fileName = encodeURIComponent(path.basename(filePath));
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || process.env.PUBLIC_URL || process.env.SERVER_URL;
  if (domain) {
    const proto = domain.startsWith('http') ? '' : 'https://';
    return `${proto}${domain}/download/${fileName}`;
  }
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}/download/${fileName}`;
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (parsedUrl.pathname.startsWith('/download/')) {
    const rawFileName = decodeURIComponent(parsedUrl.pathname.replace('/download/', ''));
    const safeFileName = path.basename(rawFileName);
    const downloadsDir = path.join(__dirname, 'downloads');
    const targetPath = path.join(downloadsDir, safeFileName);

    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${safeFileName}"`,
        'Cache-Control': 'no-cache'
      });
      const stream = fs.createReadStream(targetPath);
      stream.pipe(res);
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h2>❌ File Expired or Not Found</h2>
          <p>Yeh file 30 minute ke expiry period ke baad server se delete ho chuki hai.</p>
          <p>Kripya Telegram bot me link dobara bhej kar fresh copy download karein.</p>
        </div>
      `);
      return;
    }
  }

  // Health check endpoint for Railway
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Scribd Telegram Downloader Bot is active.');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 HTTP Server & Download Service active on port ${PORT}`);
});

// -------------------------------------------------------------
// Safe Queue & Concurrency System (Railway Free Tier Optimized)
// -------------------------------------------------------------
const activeUsers = new Set();
// On Railway Free Tier (512MB RAM), MAX_CONCURRENT=1 guarantees ZERO crashes
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '1', 10);
let runningCount = 0;
const queue = [];

function scheduleNext() {
  if (runningCount >= MAX_CONCURRENT || queue.length === 0) return;
  const task = queue.shift();
  runningCount++;
  executeTask(task).finally(() => {
    runningCount--;
    scheduleNext();
  });
}

// -------------------------------------------------------------
// Task Execution with Single Dynamic Message
// -------------------------------------------------------------
async function executeTask({ chatId, userId, docId, queuedMsgId }) {
  const startTime = Date.now();
  let statusMsg = null;
  let lastEditTime = 0;
  let lastRenderedText = '';

  // Reuse initial queue message if available
  if (queuedMsgId) {
    statusMsg = { message_id: queuedMsgId };
  }

  let lastStage = '';
  let lastReportedPercent = -1;

  // Throttled message editor: Steps every 5% and on stage change to strictly avoid Telegram's per-message edit lock (~25 edits max)
  const updateStatus = async (statusData, force = false) => {
    const now = Date.now();
    const percent = Math.min(100, Math.max(0, statusData.percent || 0));
    const isStageChange = statusData.stage && statusData.stage !== lastStage;
    if (statusData.stage) lastStage = statusData.stage;

    const percentDiff = Math.abs(percent - lastReportedPercent);
    if (!force && !isStageChange && percent !== 100 && percentDiff < 5) {
      return;
    }
    lastReportedPercent = percent;

    const elapsed = (now - startTime) / 1000;
    const bar = getProgressBar(percent);

    let stageHeader = '⚡ *SCRIBD HD DOWNLOADER*';
    let bodyText = '';

    if (statusData.stage === 'connecting') {
      stageHeader = '🔍 *CONNECTING TO SCRIBD*';
      bodyText = 
        `${statusData.text || 'Connecting to Scribd servers...'}\n` +
        `[${bar}] ${percent}%\n` +
        `⏳ *Time:* ${formatSeconds(elapsed)}`;
    } else if (statusData.stage === 'rendering') {
      stageHeader = '⚡ *RENDERING HD PAGES*';
      bodyText = 
        `${statusData.text || 'Rendering pages...'}\n` +
        `[${bar}] ${percent}%\n` +
        `⏳ *Time:* ${formatSeconds(elapsed)}`;
    } else if (statusData.stage === 'uploading') {
      stageHeader = '📤 *UPLOADING TO TELEGRAM*';
      bodyText = 
        `${statusData.text || 'Sending document...'}\n` +
        `[${bar}] ${percent}%\n` +
        `⏳ *Time:* ${formatSeconds(elapsed)}`;
    } else {
      bodyText = 
        `${statusData.text || 'Processing document...'}\n` +
        `[${bar}] ${percent}%\n` +
        `⏳ *Time:* ${formatSeconds(elapsed)}`;
    }

    const fullMessage = 
      `${stageHeader}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `${bodyText}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👨‍💻 *Made by* @cryvex4`;

    if (fullMessage === lastRenderedText) return;
    lastRenderedText = fullMessage;
    lastEditTime = now;

    try {
      if (!statusMsg) {
        statusMsg = await bot.sendMessage(chatId, fullMessage, { parse_mode: 'Markdown' });
      } else {
        await bot.editMessageText(fullMessage, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: 'Markdown'
        }).catch(() => {});
      }
    } catch (e) {
      console.warn('UI update notice:', e.message);
    }
  };

  try {
    // Stage 1: Connecting
    await updateStatus({
      stage: 'connecting',
      percent: 15,
      text: '🚀 *Launching browser engine...*'
    }, true);

    const result = await downloadScribdDocument(docId, async (progress) => {
      await updateStatus(progress);
    }, botUsername);

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Stage 3: Uploading
    await updateStatus({
      stage: 'uploading',
      percent: 40,
      text: `📤 *Uploading PDF to Telegram (${result.fileSizeMB} MB)...*`
    }, true);

    let currentUpload = 40;
    const uploadInterval = setInterval(() => {
      currentUpload = Math.min(95, currentUpload + 25);
      updateStatus({
        stage: 'uploading',
        percent: currentUpload,
        text: `📤 *Uploading PDF to Telegram (${result.fileSizeMB} MB)...*`
      });
    }, 1200);

    const caption = 
      `📚 *${result.title || 'Scribd Document'}*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📑 *Total Pages:* ${result.pageCount} Pages\n` +
      `📦 *File Size:* ${result.fileSizeMB} MB\n` +
      `⚡ *Download Time:* ${totalElapsed}s\n` +
      `🎯 *Quality:* 100% Lossless (No Clipping)\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👨‍💻 *Developer:* @cryvex4`;

    const fileSizeNum = parseFloat(result.fileSizeMB);

    // If file is > 49.5 MB, Telegram rejects it. Provide direct server download link (valid 30 mins)
    if (fileSizeNum > 49.5) {
      clearInterval(uploadInterval);
      if (statusMsg) {
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      }

      const downloadUrl = getPublicDownloadUrl(result.pdfPath);

      const largeFileMsg = 
        `📚 *${result.title || 'Scribd Document'}*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📑 *Total Pages:* ${result.pageCount} Pages\n` +
        `📦 *File Size:* ${result.fileSizeMB} MB *(Large File)*\n` +
        `⚡ *Download Time:* ${totalElapsed}s\n` +
        `🎯 *Quality:* 100% Lossless (No Clipping)\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚠️ *Telegram 50MB Limit Exceeded!*\n` +
        `Yeh PDF 50MB se bada hai, isliye ise direct Telegram chat me nahi bheja ja sakta.\n\n` +
        `Aap niche diye gaye *Direct Server Link* se is PDF ko download kar sakte hain:\n\n` +
        `🔗 *Download Link:* [Click Here to Download](${downloadUrl})\n\n` +
        `⏳ *Dhyan dein:* Yeh link sirf *30 minute* ke liye valid hai. 30 minute baad file server se automatically delete kar di jayegi!\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👨‍💻 *Developer:* @cryvex4`;

      await bot.sendMessage(chatId, largeFileMsg, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📥 Download PDF (30 Min Expiry)', url: downloadUrl }]
          ]
        }
      });
    } else {
      await bot.sendDocument(chatId, result.pdfPath, {
        caption,
        parse_mode: 'Markdown'
      });

      clearInterval(uploadInterval);

      // Delete dynamic progress message after delivery
      if (statusMsg) {
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      }
    }

    console.log(`✅ [Delivery Success] Doc ${docId} delivered to User ${userId} in ${totalElapsed}s`);
  } catch (err) {
    console.error(`❌ [Download Error] Doc ${docId}:`, err);
    if (statusMsg) {
      await bot.editMessageText(
        `❌ *Download Failed*\n\n` +
        `*Karan:* ${err.message || 'Unknown error'}\n\n` +
        `_Kripya check karein ki Scribd link public aur valid ho._\n\n` +
        `👨‍💻 *Support:* @cryvex4`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: 'Markdown'
        }
      ).catch(() => {});
    }
  } finally {
    // Release user lock
    activeUsers.delete(userId);
  }
}

// -------------------------------------------------------------
// Command: /start
// -------------------------------------------------------------
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from && msg.from.first_name ? msg.from.first_name : 'Dost';

  const welcomeText = 
    `🌟 *WELCOME TO SCRIBD HD DOWNLOADER*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Namaste *${firstName}*! Ab aap Scribd ke kisi bhi document ko bilkul *FREE* aur *100% Original Quality* me download kar sakte hain! 🚀\n\n` +
    `✨ *Key Features:*\n` +
    `├ 📄 *All Pages Complete*\n` +
    `├ 🎯 *Zero Margin Cutoff*\n` +
    `├ 🔤 *Crystal Clear Font*\n` +
    `├ 🖼️ *Full Image & Diagram Support*\n` +
    `└ ⚡ *High-Speed Cloud Engine*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `👨‍💻 *Made with ❤️ by* @cryvex4`;

  bot.sendMessage(chatId, welcomeText, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
});

// -------------------------------------------------------------
// Command: /help
// -------------------------------------------------------------
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `📖 *Help & Instructions*\n\n` +
    `1. Scribd par jayein aur document ka link copy karein.\n` +
    `2. Link is bot ko chat me bhejein.\n` +
    `3. Bot automatically pure pages render karke HD PDF bhej dega.\n\n` +
    `⚠️ *Niyam:* Ek samay par 1 hi document download kiya ja sakta hai.\n\n` +
    `👨‍💻 *Support:* @cryvex4`,
    { parse_mode: 'Markdown' }
  );
});

// -------------------------------------------------------------
// Text Message Handler (Scribd Links)
// -------------------------------------------------------------
bot.on('message', async (msg) => {
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const docId = extractScribdDocId(text);
  if (!docId) {
    return bot.sendMessage(
      chatId,
      `⚠️ *Invalid Link!*\n\n` +
      `Kripya ek valid Scribd document link bhejein.\n` +
      `*Example:* \`https://www.scribd.com/document/812641578/...\`\n\n` +
      `👨‍💻 *Support:* @cryvex4`,
      { parse_mode: 'Markdown' }
    );
  }

  // Rate Limiting: 1 active download per user check
  if (activeUsers.has(userId)) {
    return bot.sendMessage(
      chatId,
      `⚠️ *Aapka Ek Download Pehle Se Chal Raha Hai!*\n\n` +
      `Kripya uske poora hone ka intezar karein!\n\n` +
      `_Service sabhi ke liye smooth rahe isliye ek bar me 1 download allowed hai._ ⚡`,
      { parse_mode: 'Markdown' }
    );
  }

  // Mark user as active
  activeUsers.add(userId);

  // If another user is already rendering, show polite queue position message
  let queuedMsgId = null;
  if (runningCount >= MAX_CONCURRENT) {
    const queuePos = queue.length + 1;
    const qMsg = await bot.sendMessage(
      chatId,
      `⏳ *Request Queue Me Hai (#${queuePos})*\n\n` +
      `Server par ek document abhi render ho raha hai. Jaise hi wo poora hoga, aapka download *automatically* shuru ho jayega! 🚀`,
      { parse_mode: 'Markdown' }
    ).catch(() => null);
    if (qMsg) queuedMsgId = qMsg.message_id;
  }

  // Push into processing queue
  queue.push({ chatId, userId, docId, queuedMsgId });
  scheduleNext();
});
