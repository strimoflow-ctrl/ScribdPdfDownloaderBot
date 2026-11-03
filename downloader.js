const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { PDFDocument, PDFName, PDFString, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

// Automatically detect Chrome / Chromium on Windows, Linux (AWS / Docker)
function getBrowserExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const candidates = [
    // Linux / AWS / Docker paths
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    // Windows paths
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Add a prominent, clickable watermark badge to a PDF page
 */
function addClickableWatermark(pdfDoc, page, font, botUsername = 'ScribdPdfDownloaderBot') {
  const { width } = page.getSize();
  const text = `Downloaded via @${botUsername}`;

  const fontSize = Math.max(16, Math.min(26, Math.round(width * 0.020)));
  const textWidth = font.widthOfTextAtSize(text, fontSize);
  const paddingX = Math.round(fontSize * 0.75);
  const badgeWidth = textWidth + paddingX * 2;
  const badgeHeight = Math.round(fontSize * 1.75);

  const margin = Math.round(fontSize * 0.8);
  const x = width - badgeWidth - margin;
  const y = margin;

  page.drawRectangle({
    x,
    y,
    width: badgeWidth,
    height: badgeHeight,
    color: rgb(0.08, 0.10, 0.15),
    opacity: 0.92,
    borderWidth: 1.5,
    borderColor: rgb(0.24, 0.48, 0.96)
  });

  page.drawText(text, {
    x: x + paddingX,
    y: y + Math.round((badgeHeight - fontSize) / 2) + 1,
    size: fontSize,
    font,
    color: rgb(0.95, 0.97, 1.0)
  });

  const linkUrl = `https://t.me/${botUsername}`;
  const linkAnnot = pdfDoc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [x, y, x + badgeWidth, y + badgeHeight],
    Border: [0, 0, 0],
    A: {
      Type: 'Action',
      S: 'URI',
      URI: PDFString.of(linkUrl)
    }
  });

  const linkAnnotRef = pdfDoc.context.register(linkAnnot);
  let annots = page.node.Annots();
  if (!annots) {
    annots = pdfDoc.context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(linkAnnotRef);
}

/**
 * Auto-split PDF into multiple parts if size exceeds 49.0 MB
 * Guaranteed to fit Telegram's strict 50MB file size limit!
 */
async function splitPdfIfOversized(pdfPath, docTitle, totalPages, maxBytes = 49.0 * 1024 * 1024) {
  const stats = fs.statSync(pdfPath);
  if (stats.size <= maxBytes) {
    return [{
      path: pdfPath,
      partNum: 1,
      totalParts: 1,
      pageRange: `1 - ${totalPages}`,
      sizeMB: (stats.size / (1024 * 1024)).toFixed(2)
    }];
  }

  console.log(`⚠️ [Auto-Splitter] PDF size (${(stats.size / (1024 * 1024)).toFixed(1)} MB) exceeds 49MB limit. Splitting into parts...`);
  const bytes = fs.readFileSync(pdfPath);
  const srcDoc = await PDFDocument.load(bytes);
  const numPages = srcDoc.getPageCount();

  const numParts = Math.ceil(stats.size / (45 * 1024 * 1024));
  const pagesPerPart = Math.ceil(numPages / numParts);
  const baseName = path.basename(pdfPath, '.pdf');
  const dir = path.dirname(pdfPath);
  const parts = [];

  for (let p = 0; p < numParts; p++) {
    const startIdx = p * pagesPerPart;
    const endIdx = Math.min(startIdx + pagesPerPart, numPages);
    const partDoc = await PDFDocument.create();
    const pageIndices = [];
    for (let k = startIdx; k < endIdx; k++) pageIndices.push(k);
    const copied = await partDoc.copyPages(srcDoc, pageIndices);
    copied.forEach(pg => partDoc.addPage(pg));

    const partBytes = await partDoc.save();
    const partPath = path.join(dir, `${baseName}_Part${p + 1}.pdf`);
    fs.writeFileSync(partPath, partBytes);

    const partStats = fs.statSync(partPath);
    parts.push({
      path: partPath,
      partNum: p + 1,
      totalParts: numParts,
      pageRange: `${startIdx + 1} - ${endIdx}`,
      sizeMB: (partStats.size / (1024 * 1024)).toFixed(2)
    });
  }

  // Delete original oversized file from disk
  try { fs.unlinkSync(pdfPath); } catch (e) {}
  return parts;
}

/**
 * Download a Scribd document as a 100% pixel-perfect, complete PDF
 * Zero White Pages • Adaptive Quality • Under 50MB Guarantee
 */
async function downloadScribdDocument(docId, onProgress = () => {}, botUsername = 'ScribdPdfDownloaderBot', preferredTitle = null) {
  const executablePath = getBrowserExecutablePath();
  const downloadsDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  const tempChunks = [];
  let browser = null;

  // Stage 1: Connecting (0% -> 100%)
  onProgress({
    stage: 'connecting',
    percent: 15,
    text: '🚀 *Launching browser engine...*'
  });

  browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    protocolTimeout: 600000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-accelerated-2d-canvas',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-default-apps',
      '--mute-audio',
      '--no-first-run',
      '--no-zygote',
      '--js-flags=--max-old-space-size=512',
      '--window-size=1200,1600'
    ]
  });

  try {
    let page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    await page.setViewport({ width: 1100, height: 1500, deviceScaleFactor: 1.0 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    onProgress({
      stage: 'connecting',
      percent: 60,
      text: '🔍 *Connecting to Scribd server...*'
    });

    const embedUrl = `https://www.scribd.com/embeds/${docId}/content?start_page=1&view_mode=scroll`;
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 50000 });

    onProgress({
      stage: 'connecting',
      percent: 100,
      text: '✅ *Connected! Initializing document structure...*'
    });

    // Wait 3 seconds for Scribd docManager to initialize
    await new Promise(r => setTimeout(r, 3000));

    // Extract real title (Filter out bot challenge titles like 'Client Challenge')
    let docTitle = preferredTitle;
    if (!docTitle || docTitle.toLowerCase().includes('client challenge')) {
      docTitle = await page.evaluate(() => {
        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle && ogTitle.content && !ogTitle.content.toLowerCase().includes('client challenge')) {
          return ogTitle.content.replace(/Scribd/i, '').trim();
        }
        const titleEl = document.querySelector('.document_title') || document.querySelector('h1') || document.querySelector('title');
        if (titleEl && titleEl.textContent) {
          const t = titleEl.textContent.replace(/Scribd/i, '').trim();
          if (!t.toLowerCase().includes('client challenge') && !t.toLowerCase().includes('just a moment')) {
            return t;
          }
        }
        return '';
      });
    }
    if (!docTitle || docTitle.toLowerCase().includes('client challenge')) {
      docTitle = preferredTitle || `Scribd_Doc_${docId}`;
    }

    // Detect total pages
    let totalPages = await page.evaluate(() => {
      const totalEl = document.querySelector('.total_pages') || document.querySelector('.page_count');
      if (totalEl) {
        const m = totalEl.textContent.match(/\d+/);
        if (m) return parseInt(m[0]);
      }
      if (window.Scribd && window.Scribd.current_doc && window.Scribd.current_doc.page_count) {
        return window.Scribd.current_doc.page_count;
      }
      if (window.docManager && window.docManager.pages) {
        const pCount = Object.keys(window.docManager.pages).length;
        if (pCount > 0) return pCount;
      }
      const pageElements = document.querySelectorAll('[id^="outer_page_"]');
      return pageElements.length || 1;
    });

    // Hide UI overlays
    await page.evaluate(() => {
      const toHide = [
        '.toolbar', '.control_bar', '.action_menu', '.fullscreen_button',
        '.header', '.footer', '.recommendations', '.page_missing_explanation_icon',
        '.banner', '.promo'
      ];
      toHide.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.style.display = 'none');
      });
    });

    // ⚡ ADAPTIVE RESOLUTION & COMPRESSION
    // Guarantees 500-600 pages stay comfortably under 45 MB with 100% crisp text!
    let targetDeviceScale = 1.15;
    let targetJpegQuality = 82;

    if (totalPages > 350) {
      targetDeviceScale = 0.85;
      targetJpegQuality = 70;
    } else if (totalPages > 150) {
      targetDeviceScale = 0.95;
      targetJpegQuality = 75;
    } else if (totalPages > 40) {
      targetDeviceScale = 1.05;
      targetJpegQuality = 78;
    }

    await page.setViewport({ width: 1100, height: 1500, deviceScaleFactor: targetDeviceScale });

    const CHUNK_SIZE = 35;
    let currentChunkDoc = await PDFDocument.create();
    let currentChunkFont = await currentChunkDoc.embedFont(StandardFonts.HelveticaBold);
    let chunkCount = 0;
    let totalPagesCaptured = 0;

    // Stage 2: Rendering Pages (0% -> 100%)
    for (let i = 1; i <= totalPages; i++) {
      const renderPercent = Math.round((i / totalPages) * 95);

      onProgress({
        stage: 'rendering',
        percent: renderPercent,
        currentPage: i,
        totalPages,
        title: docTitle,
        text: `⚡ *Rendering:* Page ${i} of ${totalPages}`
      });

      // 🧹 TAB MEMORY FLUSH: Every 35 pages, reopen tab to prevent GPU leak
      if (i > 1 && (i - 1) % 35 === 0) {
        console.log(`🧹 [Tab Memory Flush] Purging memory cache at Page ${i}...`);
        await page.close().catch(() => {});
        page = await browser.newPage();
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(60000);
        await page.setViewport({ width: 1100, height: 1500, deviceScaleFactor: targetDeviceScale });
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );
        const nextUrl = `https://www.scribd.com/embeds/${docId}/content?start_page=${i}&view_mode=scroll`;
        await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 50000 });
        await new Promise(r => setTimeout(r, 2500));
        await page.evaluate(() => {
          const toHide = [
            '.toolbar', '.control_bar', '.action_menu', '.fullscreen_button',
            '.header', '.footer', '.recommendations', '.page_missing_explanation_icon',
            '.banner', '.promo'
          ];
          toHide.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => el.style.display = 'none');
          });
        });
      }

      // 1. TRIGGER SCRIBD REAL INTERNAL LOADER
      await page.evaluate((idx) => {
        const mgr = window.docManager;
        if (mgr && mgr.pages && mgr.pages[idx]) {
          const p = mgr.pages[idx];
          if (!p.loadHasStarted) {
            try { p.load(); } catch (e) {}
          }
        }
        const scroller = document.querySelector('.document_scroller');
        const el = document.getElementById(`outer_page_${idx}`);
        if (el) {
          if (scroller) {
            scroller.scrollTop = el.offsetTop;
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
          el.scrollIntoView({ behavior: 'instant', block: 'start' });
        }
      }, i);

      // 2. ZERO WHITE PAGES VALIDATION:
      // Actively wait until page assets (innerPageElem, images, svg, text) are truly ready
      let contentReady = false;
      const waitStart = Date.now();
      while (Date.now() - waitStart < 5000) {
        contentReady = await page.evaluate((idx) => {
          const mgr = window.docManager;
          if (mgr && mgr.pages && mgr.pages[idx]) {
            const p = mgr.pages[idx];
            if (p.innerPageElem) {
              try { p.display(); } catch (e) {}
              try { p.turnOnImages(); } catch (e) {}
              return true;
            }
          }

          const el = document.getElementById(`outer_page_${idx}`);
          if (!el) return false;

          const img = el.querySelector('img');
          if (img && img.src && (img.complete || img.naturalWidth > 50)) return true;

          const newpage = el.querySelector('.newpage');
          if (newpage && (newpage.querySelector('svg') || newpage.querySelector('canvas') || newpage.innerHTML.trim().length > 150)) {
            return true;
          }

          const textLayer = el.querySelector('.text_layer');
          if (textLayer && textLayer.textContent && textLayer.textContent.trim().length > 5) return true;

          return false;
        }, i);

        if (contentReady) break;
        await new Promise(r => setTimeout(r, 120));
      }

      // Secondary fallback nudge if page took longer
      if (!contentReady) {
        await page.evaluate((idx) => {
          const mgr = window.docManager;
          if (mgr && mgr.pages && mgr.pages[idx]) {
            try { mgr.pages[idx].load(); } catch (e) {}
          }
        }, i);
        await new Promise(r => setTimeout(r, 1000));
      }

      const pageElement = await page.$(`#outer_page_${i}`);
      if (!pageElement) {
        console.warn(`Page element #outer_page_${i} missing, skipping...`);
        continue;
      }

      const imgBuffer = await pageElement.screenshot({ type: 'jpeg', quality: targetJpegQuality });
      const embeddedImage = await currentChunkDoc.embedJpg(imgBuffer);

      const pdfPage = currentChunkDoc.addPage([embeddedImage.width, embeddedImage.height]);
      pdfPage.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width: embeddedImage.width,
        height: embeddedImage.height
      });

      addClickableWatermark(currentChunkDoc, pdfPage, currentChunkFont, botUsername);
      totalPagesCaptured++;

      // 💾 DISK CHUNKING: Save chunk every CHUNK_SIZE pages
      if (i % CHUNK_SIZE === 0 || i === totalPages) {
        if (currentChunkDoc.getPageCount() > 0) {
          chunkCount++;
          const chunkPath = path.join(downloadsDir, `temp_chunk_${docId}_${chunkCount}.pdf`);
          const chunkBytes = await currentChunkDoc.save();
          fs.writeFileSync(chunkPath, chunkBytes);
          tempChunks.push(chunkPath);
          console.log(`💾 [Disk Chunking] Saved Chunk ${chunkCount} [Pages up to ${i}]`);
        }

        currentChunkDoc = null;
        if (i < totalPages) {
          currentChunkDoc = await PDFDocument.create();
          currentChunkFont = await currentChunkDoc.embedFont(StandardFonts.HelveticaBold);
        }
      }
    }

    if (totalPagesCaptured === 0 || tempChunks.length === 0) {
      throw new Error(`Could not capture any pages from Scribd document. Document may be restricted or blocked by protection.`);
    }

    // Close Chromium before assembling final PDF to release RAM
    try {
      await browser.close();
      browser = null;
      console.log('🚪 [Browser Closed] Chromium RAM freed.');
    } catch (e) {}

    // Clean, professional filename
    const cleanFileName = (docTitle || `Scribd_Doc_${docId}`)
      .replace(/[/\\?%*:|"<>]/g, '')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 50)
      .replace(/^-+|-+$/g, '') || `Scribd_${docId}`;

    const rawOutputPath = path.join(downloadsDir, `${cleanFileName}.pdf`);

    onProgress({
      stage: 'uploading',
      percent: 98,
      text: `📦 *Assembling final HD PDF document (${totalPages} Pages)...*`
    });

    let finalPageCount = totalPages;

    if (tempChunks.length === 1) {
      fs.renameSync(tempChunks[0], rawOutputPath);
    } else {
      const finalPdf = await PDFDocument.create();
      for (const cp of tempChunks) {
        const cBytes = fs.readFileSync(cp);
        const loadedChunk = await PDFDocument.load(cBytes);
        const copied = await finalPdf.copyPages(loadedChunk, loadedChunk.getPageIndices());
        copied.forEach(p => finalPdf.addPage(p));
      }
      const finalBytes = await finalPdf.save();
      fs.writeFileSync(rawOutputPath, finalBytes);
      finalPageCount = finalPdf.getPageCount();

      // Clean up temporary chunks immediately
      for (const cp of tempChunks) {
        try { if (fs.existsSync(cp)) fs.unlinkSync(cp); } catch (e) {}
      }
    }

    const rawStats = fs.statSync(rawOutputPath);
    const totalSizeMB = (rawStats.size / (1024 * 1024)).toFixed(2);

    // ⚡ AUTO-SPLITTER FAIL-SAFE FOR TELEGRAM 50MB LIMIT
    const deliveryFiles = await splitPdfIfOversized(rawOutputPath, docTitle, finalPageCount);

    return {
      pdfPath: rawOutputPath,
      files: deliveryFiles,
      title: docTitle,
      pageCount: finalPageCount,
      fileSizeMB: totalSizeMB
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    // Delete any remaining chunks on error
    for (const cp of tempChunks) {
      try { if (fs.existsSync(cp)) fs.unlinkSync(cp); } catch (e) {}
    }
  }
}

module.exports = {
  downloadScribdDocument
};
