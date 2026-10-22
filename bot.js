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

const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    params: {
      allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member']
    }
  }
});

let botUsername = 'ScribdPdfDownloaderBot';
bot.getMe().then(me => {
  botUsername = me.username || botUsername;
  console.log(`🤖 Bot is active as: @${botUsername}`);
}).catch(err => {
  console.warn('Bot info fetch warning:', err.message);
});

const FORCE_SUB_CHANNEL = process.env.FORCE_SUB_CHANNEL || ''; // e.g. @MyChannel or -100...
let cachedInviteLink = process.env.FORCE_SUB_URL || '';
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || ''; // e.g. @MyPublicGroup or -100...

// Resolve channel invite link automatically (handles @username and private -100... channels)
async function getChannelInviteUrl() {
  if (cachedInviteLink) return cachedInviteLink;
  if (!FORCE_SUB_CHANNEL) return '';

  if (FORCE_SUB_CHANNEL.startsWith('@')) {
    cachedInviteLink = `https://t.me/${FORCE_SUB_CHANNEL.replace('@', '')}`;
    return cachedInviteLink;
  }

  try {
    const chat = await bot.getChat(FORCE_SUB_CHANNEL);
    if (chat.username) {
      cachedInviteLink = `https://t.me/${chat.username}`;
    } else if (chat.invite_link) {
      cachedInviteLink = chat.invite_link;
    } else {
      cachedInviteLink = await bot.exportChatInviteLink(FORCE_SUB_CHANNEL);
    }
    console.log(`🔗 [FSub] Resolved channel invite link: ${cachedInviteLink}`);
    return cachedInviteLink;
  } catch (err) {
    console.warn(`[FSub Link Error] Could not export chat invite link for ${FORCE_SUB_CHANNEL}: ${err.message}`);
    return '';
  }
}

// Pre-fetch link on startup if configured
if (FORCE_SUB_CHANNEL) {
  getChannelInviteUrl().then(url => {
    if (url) console.log(`📢 Force Subscribe active on: ${FORCE_SUB_CHANNEL} (${url})`);
  });
}
if (LOG_CHANNEL_ID) console.log(`📡 Public Channel Forwarding active on: ${LOG_CHANNEL_ID}`);

// Helper: Extract Scribd Document ID and URL Slug
function extractScribdInfo(text) {
  if (!text) return null;
  const match = text.match(/scribd\.com\/(?:document|doc|presentation|embeds)\/(\d+)(?:\/([a-zA-Z0-9_-]+))?/i);
  if (match) {
    return {
      docId: match[1],
      urlSlug: match[2] || null
    };
  }
  const idMatch = text.match(/[?&]doc_id=(\d+)/i);
  if (idMatch) return { docId: idMatch[1], urlSlug: null };
  const trimmed = text.trim();
  if (/^\d{6,12}$/.test(trimmed)) return { docId: trimmed, urlSlug: null };
  return null;
}

// Helper: Quick metadata & cover fetcher
async function fetchScribdMetadata(docId, urlSlug) {
  let title = urlSlug ? urlSlug.replace(/[-_]+/g, ' ').trim() : '';
  let coverUrl = null;
  try {
    const resp = await fetch(`https://www.scribd.com/document/${docId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(6000)
    });
    const html = await resp.text();
    const tm = html.match(/<title>([^<]+)<\/title>/i);
    if (tm) {
      title = tm[1].split('|')[0].replace(/Scribd/i, '').replace(/&amp;/g, '&').trim();
    }
    const im = html.match(/<meta property="og:image" content="([^"]+)"/i);
    if (im) {
      coverUrl = im[1];
    }
  } catch (e) {}
  return { title: title || `Scribd Document ${docId}`, coverUrl };
}

// Membership checker for Force Subscribe
async function checkMembership(userId) {
  if (!FORCE_SUB_CHANNEL) return true;
  try {
    const member = await bot.getChatMember(FORCE_SUB_CHANNEL, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (err) {
    console.warn(`[FSub Warning] ${err.message}`);
    return true; // Don't block users if channel isn't set up or bot isn't admin
  }
}

// Sleek, compact join prompt
async function sendJoinPrompt(chatId, docId = null, urlSlug = null) {
  const inviteUrl = await getChannelInviteUrl();
  const text = 
    `🔒 *Access Locked!*\n\n` +
    `Bot use karne ke liye pehle hamare official channel ko join karein. Join karte hi aapka download activate ho jayega! ✨`;

  const callbackData = docId ? `check_${docId}${urlSlug ? ':' + urlSlug : ''}` : 'check_idle';
  const buttons = [];
  if (inviteUrl) {
    buttons.push([{ text: '📢 Join Official Channel', url: inviteUrl }]);
  }
  buttons.push([{ text: '🔄 Joined / Try Again', callback_data: callbackData }]);

  const keyboard = {
    inline_keyboard: buttons
  };

  return bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
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
  if (domain && !domain.includes('localhost') && !domain.includes('127.0.0.1')) {
    const proto = domain.startsWith('http') ? '' : 'https://';
    return `${proto}${domain}/download/${fileName}`;
  }
  return null;
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
async function executeTask({ chatId, userId, user, docId, urlSlug, meta: preMeta, queuedMsgId, simInterval }) {
  // Clear queued heartbeat simulation timer if any
  if (simInterval) {
    clearInterval(simInterval);
  }

  const startTime = Date.now();
  let statusMsg = null;
  let lastRenderedText = '';

  // Reuse initial dynamic message if created
  if (queuedMsgId) {
    statusMsg = { message_id: queuedMsgId };
  }

  let lastStage = '';
  let lastReportedPercent = -1;

  // Throttled message editor: Steps every 5% and on stage change
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
    const meta = preMeta || await fetchScribdMetadata(docId, urlSlug);

    // If cover was not sent in startDownloadTask, send it now
    if (!preMeta && meta.coverUrl) {
      await bot.sendPhoto(chatId, meta.coverUrl, {
        caption: `📖 *${meta.title}*\n⚡ *Connected! Starting high-speed render...*`,
        parse_mode: 'Markdown'
      }).catch(() => null);
    }

    // Stage 1: Connecting
    await updateStatus({
      stage: 'connecting',
      percent: 15,
      text: `🚀 *Opening:* ${meta.title}`
    }, true);

    const result = await downloadScribdDocument(docId, async (progress) => {
      await updateStatus(progress);
    }, botUsername, meta.title);

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

      let buttons = [];
      let linkSection = '';

      if (downloadUrl) {
        linkSection = `🔗 *Download Link:* [Click Here to Download](${downloadUrl})\n\n`;
        buttons.push([{ text: '📥 Download PDF (30 Min Expiry)', url: downloadUrl }]);
      } else {
        linkSection = 
          `⚠️ *Notice:* Direct download service public URL is being assigned.\n` +
          `File is saved on server. (Make sure Railway Networking domain is generated!)\n\n`;
      }

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
        `${linkSection}` +
        `⏳ *Dhyan dein:* Yeh link sirf *30 minute* ke liye valid hai. 30 minute baad file server se automatically delete kar di jayegi!\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👨‍💻 *Developer:* @cryvex4`;

      const msgOpts = { parse_mode: 'Markdown' };
      if (buttons.length > 0) {
        msgOpts.reply_markup = { inline_keyboard: buttons };
      }

      await bot.sendMessage(chatId, largeFileMsg, msgOpts);
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

    // 📡 Public Channel / Group Auto-Forwarding
    if (LOG_CHANNEL_ID) {
      const userMention = (user && user.username) 
        ? `@${user.username}` 
        : ((user && user.first_name) ? user.first_name : 'Anonymous');

      const logCaption = 
        `📚 *${result.title}*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📑 *Pages:* ${result.pageCount} Pages\n` +
        `📦 *Size:* ${result.fileSizeMB} MB\n` +
        `👤 *Downloaded By:* ${userMention}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🤖 *Download via:* @${botUsername}`;

      if (fileSizeNum <= 49.5) {
        await bot.sendDocument(LOG_CHANNEL_ID, result.pdfPath, {
          caption: logCaption,
          parse_mode: 'Markdown'
        }).catch(e => console.warn('[Log Channel Send Error]:', e.message));
      } else {
        const downloadUrl = getPublicDownloadUrl(result.pdfPath);
        const logOpts = { parse_mode: 'Markdown' };
        if (downloadUrl) {
          logOpts.reply_markup = {
            inline_keyboard: [[{ text: '📥 Download PDF (High Speed)', url: downloadUrl }]]
          };
        }
        await bot.sendMessage(LOG_CHANNEL_ID, logCaption, logOpts).catch(e => console.warn('[Log Channel Msg Error]:', e.message));
      }
    }

    // 🧹 Instant Disk Cleanup: Delete from server disk immediately once delivered (< 50MB)
    if (fileSizeNum <= 49.5) {
      try {
        if (fs.existsSync(result.pdfPath)) {
          fs.unlinkSync(result.pdfPath);
          console.log(`🧹 [Instant Clean] Deleted delivered PDF from disk: ${path.basename(result.pdfPath)}`);
        }
      } catch (cleanErr) {
        console.warn('File cleanup notice:', cleanErr.message);
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

// Helper: Start download task or enqueue with active provisioning animation
async function startDownloadTask(chatId, userId, user, docId, urlSlug) {
  if (activeUsers.has(userId)) {
    return bot.sendMessage(
      chatId,
      `⚠️ *Aapka Ek Download Pehle Se Chal Raha Hai!*\n\n` +
      `Kripya uske poora hone ka intezar karein!\n\n` +
      `_Service sabhi ke liye smooth rahe isliye ek bar me 1 download allowed hai._ ⚡`,
      { parse_mode: 'Markdown' }
    );
  }

  activeUsers.add(userId);

  // Quick metadata & Instant Cover Preview
  const meta = await fetchScribdMetadata(docId, urlSlug);
  if (meta.coverUrl) {
    await bot.sendPhoto(chatId, meta.coverUrl, {
      caption: `📖 *${meta.title}*\n⚡ *Connected! Initializing Cloud Pipeline...*`,
      parse_mode: 'Markdown'
    }).catch(() => null);
  }

  let queuedMsgId = null;
  let simInterval = null;

  if (runningCount >= MAX_CONCURRENT) {
    // Active Provisioning UX: User sees dynamic cloud allocation, NOT a boring wait message!
    const initText = 
      `⚡ *INITIALIZING DOCUMENT PIPELINE*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📖 *Document:* ${meta.title}\n` +
      `⚙️ *Allocating Dedicated Cloud Core...*\n` +
      `[███░░░░░░░] 25%\n` +
      `⏳ *Status:* Pre-caching Scribd stream & structure...\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👨‍💻 *Made by* @cryvex4`;

    const qMsg = await bot.sendMessage(chatId, initText, { parse_mode: 'Markdown' }).catch(() => null);
    if (qMsg) {
      queuedMsgId = qMsg.message_id;

      const simStages = [
        { percent: 40, bar: '████░░░░░░', text: '🔄 Pre-loading document metadata & fonts...' },
        { percent: 60, bar: '██████░░░░', text: '🛡️ Preparing 100% Lossless render buffer...' },
        { percent: 80, bar: '████████░░', text: '⚡ Cloud Core synchronized! Finalizing render queue...' }
      ];
      let stageIdx = 0;
      simInterval = setInterval(async () => {
        if (stageIdx >= simStages.length) return;
        const cur = simStages[stageIdx++];
        const updatedSim = 
          `⚡ *INITIALIZING DOCUMENT PIPELINE*\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `📖 *Document:* ${meta.title}\n` +
          `⚙️ *Configuring High-Speed Worker...*\n` +
          `[${cur.bar}] ${cur.percent}%\n` +
          `⏳ *Status:* ${cur.text}\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `👨‍💻 *Made by* @cryvex4`;

        await bot.editMessageText(updatedSim, {
          chat_id: chatId,
          message_id: queuedMsgId,
          parse_mode: 'Markdown'
        }).catch(() => {});
      }, 3500);
    }
  }

  queue.push({
    chatId,
    userId,
    user,
    docId,
    urlSlug,
    meta,
    queuedMsgId,
    simInterval
  });

  scheduleNext();
}

// -------------------------------------------------------------
// Callback Query Handler (Force Subscribe verification)
// -------------------------------------------------------------
bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data && data.startsWith('check_')) {
    const isMember = await checkMembership(userId);
    if (!isMember) {
      return bot.answerCallbackQuery(query.id, {
        text: '⚠️ Aapne abhi tak channel join nahi kiya hai! Kripya pehle channel join karein.',
        show_alert: true
      });
    }

    await bot.answerCallbackQuery(query.id, {
      text: '✅ Membership Verified! Welcome!'
    });

    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});

    const rawParam = data.replace('check_', '');
    if (rawParam && rawParam !== 'start' && rawParam !== 'idle') {
      const parts = rawParam.split(':');
      const pendingDocId = parts[0];
      const pendingSlug = parts[1] || null;
      startDownloadTask(chatId, userId, query.from, pendingDocId, pendingSlug);
    } else {
      bot.sendMessage(
        chatId,
        `✅ *Verification Successful!*\n\nAb aap koi bhi Scribd link bhej kar download kar sakte hain! 🚀`,
        { parse_mode: 'Markdown' }
      );
    }
  }
});

// -------------------------------------------------------------
// Command: /start
// -------------------------------------------------------------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Check channel membership on /start
  const isMember = await checkMembership(userId);
  if (!isMember) {
    return sendJoinPrompt(chatId, null, null);
  }

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

  const info = extractScribdInfo(text);
  if (!info) {
    return bot.sendMessage(
      chatId,
      `⚠️ *Invalid Link!*\n\n` +
      `Kripya ek valid Scribd document link bhejein.\n` +
      `*Example:* \`https://www.scribd.com/document/812641578/...\`\n\n` +
      `👨‍💻 *Support:* @cryvex4`,
      { parse_mode: 'Markdown' }
    );
  }

  // 🔒 Real-time Force Subscribe Check on every link
  const isMember = await checkMembership(userId);
  if (!isMember) {
    return sendJoinPrompt(chatId, info.docId, info.urlSlug);
  }

  startDownloadTask(chatId, userId, msg.from, info.docId, info.urlSlug);
});

// -------------------------------------------------------------
// Real-time Channel Leave Detector (Warns user instantly on leave)
// -------------------------------------------------------------
bot.on('chat_member', async (update) => {
  try {
    if (!FORCE_SUB_CHANNEL) return;

    const updateChatId = update.chat.id.toString();
    const targetChannel = FORCE_SUB_CHANNEL.toString();

    const isTargetChannel =
      updateChatId === targetChannel ||
      (update.chat.username && `@${update.chat.username}`.toLowerCase() === targetChannel.toLowerCase());

    if (!isTargetChannel) return;

    const oldStatus = update.old_chat_member ? update.old_chat_member.status : '';
    const newStatus = update.new_chat_member ? update.new_chat_member.status : '';
    const targetUserId = update.new_chat_member?.user?.id || update.from?.id;

    if (['member', 'administrator'].includes(oldStatus) && ['left', 'kicked', 'restricted'].includes(newStatus)) {
      if (targetUserId) {
        const inviteUrl = await getChannelInviteUrl();
        const buttons = [];
        if (inviteUrl) {
          buttons.push([{ text: '📢 Re-Join Channel', url: inviteUrl }]);
        }
        buttons.push([{ text: '🔄 Verify Membership', callback_data: 'check_idle' }]);

        await bot.sendMessage(
          targetUserId,
          `⚠️ *Aapne Channel Leave Kar Diya Hai!*\n\n` +
          `Aap official channel se nikal chuke hain, isliye aapka download access lock ho gaya hai. ❌\n\n` +
          `Download suvidha turant wapas activate karne ke liye kripya channel dobara join karein! ✨`,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
          }
        ).catch(err => {
          console.warn(`[Leave Notice] Could not send DM to user ${targetUserId}: ${err.message}`);
        });
      }
    }
  } catch (err) {
    console.warn(`[chat_member error] ${err.message}`);
  }
});
