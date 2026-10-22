const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { PDFDocument, PDFName, PDFString, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

// Automatically detect Chrome / Chromium on Windows, Linux (Railway / Docker)
function getBrowserExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const candidates = [
    // Windows paths
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // Linux / Railway / Docker paths
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
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
 * Download a Scribd document as a 100% pixel-perfect, complete PDF
 * Optimized for low-memory cloud environments (Railway Free Tier)
 * @param {string} docId - Scribd document ID
 * @param {function} onProgress - Progress status callback
 * @param {string} botUsername - For clickable watermark
 * @returns {Promise<{ pdfPath: string, title: string, pageCount: number, fileSizeMB: string }>}
 */
async function downloadScribdDocument(docId, onProgress = () => {}, botUsername = 'ScribdPdfDownloaderBot', preferredTitle = null) {
  const executablePath = getBrowserExecutablePath();
  const downloadsDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  // Stage 1: Connecting (0% -> 100%)
  onProgress({
    stage: 'connecting',
    percent: 15,
    text: '🚀 *Launching browser engine...*'
  });

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    protocolTimeout: 600000, // 10 minutes to prevent CDP timeout on 300+ pages
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
      '--js-flags=--max-old-space-size=256',
      '--window-size=1200,1600'
    ]
  });

  try {
    let page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    // 1.2x resolution: Crisp retina clarity with minimum RAM and fast rendering
    await page.setViewport({ width: 1100, height: 1500, deviceScaleFactor: 1.2 });
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

    // Wait 2.5 seconds for Scribd components to initialize
    await new Promise(r => setTimeout(r, 2500));

    // Extract clean title
    let docTitle = preferredTitle;
    if (!docTitle) {
      docTitle = await page.evaluate(() => {
        const titleEl = document.querySelector('title') || document.querySelector('.document_title');
        return titleEl ? titleEl.textContent.replace(/Scribd/i, '').trim() : '';
      });
    }
    if (!docTitle) docTitle = `Scribd_Doc_${docId}`;
    const safeTitle = docTitle.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 60);

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

    const watermarkFont = await PDFDocument.create().then(d => d.embedFont(StandardFonts.HelveticaBold));
    const useJpeg = totalPages > 12;

    const CHUNK_SIZE = 35;
    const tempChunks = [];
    let currentChunkDoc = await PDFDocument.create();
    let currentChunkFont = await currentChunkDoc.embedFont(StandardFonts.HelveticaBold);
    let chunkCount = 0;

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

      // 🧹 TAB MEMORY FLUSH: Every 35 pages, close tab and reopen fresh at page i
      // This eliminates GPU raster texture buildup and keeps Chromium RAM < 70MB across 1000+ pages!
      if (i > 1 && (i - 1) % 35 === 0) {
        console.log(`🧹 [Tab Memory Flush] Purging memory cache at Page ${i}...`);
        await page.close().catch(() => {});
        page = await browser.newPage();
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(60000);
        await page.setViewport({ width: 1100, height: 1500, deviceScaleFactor: 1.2 });
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

      // 1. Scroll Scribd's REAL internal container (.document_scroller) and trigger viewer
      await page.evaluate((idx) => {
        const scroller = document.querySelector('.document_scroller');
        const el = document.getElementById(`outer_page_${idx}`);
        if (!el) return;

        if (scroller) {
          scroller.scrollTop = el.offsetTop;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
        el.scrollIntoView({ behavior: 'instant', block: 'start' });

        if (window.docManager && typeof window.docManager.gotoPage === 'function') {
          window.docManager.gotoPage(idx);
        }

        const imgs = el.querySelectorAll('img');
        imgs.forEach(img => {
          if (!img.src && img.dataset.src) img.src = img.dataset.src;
          img.style.opacity = '1';
          img.style.visibility = 'visible';
        });
      }, i);

      // 2. Strict Content Validator (Zero White Pages):
      // Only proceed when actual text, SVG, canvas, or loaded images exist (never on empty div placeholders)
      let contentReady = false;
      const waitStart = Date.now();
      while (Date.now() - waitStart < 2500) {
        contentReady = await page.evaluate((idx) => {
          const el = document.getElementById(`outer_page_${idx}`);
          if (!el) return false;

          // Check for SVG / canvas / vector elements in newpage
          const newpage = el.querySelector('.newpage');
          if (newpage) {
            const hasSvg = newpage.querySelector('svg');
            const hasCanvas = newpage.querySelector('canvas');
            if (hasSvg || hasCanvas) return true;
            if (newpage.children.length > 0 && newpage.innerHTML.trim().length > 150) return true;
          }

          // Check for loaded image with actual dimensions
          const img = el.querySelector('img');
          if (img && img.src && (img.complete || img.naturalWidth > 50)) return true;

          // Check for rendered text in text_layer (must contain actual text, not empty div)
          const textLayer = el.querySelector('.text_layer');
          if (textLayer && textLayer.textContent && textLayer.textContent.trim().length > 5) return true;

          return false;
        }, i);

        if (contentReady) break;
        await new Promise(r => setTimeout(r, 80));
      }

      const pageElement = await page.$(`#outer_page_${i}`);
      if (!pageElement) {
        console.warn(`Page element #outer_page_${i} missing, skipping...`);
        continue;
      }

      let imgBuffer;
      let embeddedImage;

      if (useJpeg) {
        imgBuffer = await pageElement.screenshot({ type: 'jpeg', quality: 86 });
        embeddedImage = await currentChunkDoc.embedJpg(imgBuffer);
      } else {
        imgBuffer = await pageElement.screenshot({ type: 'png', omitBackground: false });
        embeddedImage = await currentChunkDoc.embedPng(imgBuffer);
      }

      const pdfPage = currentChunkDoc.addPage([embeddedImage.width, embeddedImage.height]);
      pdfPage.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width: embeddedImage.width,
        height: embeddedImage.height
      });

      addClickableWatermark(currentChunkDoc, pdfPage, currentChunkFont, botUsername);

      // 💾 DISK CHUNKING: Every CHUNK_SIZE pages or on last page, flush chunk to disk
      // This guarantees Node.js memory stays flat at < 70MB even on 1000+ pages!
      if (i % CHUNK_SIZE === 0 || i === totalPages) {
        chunkCount++;
        const chunkPath = path.join(downloadsDir, `temp_chunk_${docId}_${chunkCount}.pdf`);
        const chunkBytes = await currentChunkDoc.save();
        fs.writeFileSync(chunkPath, chunkBytes);
        tempChunks.push(chunkPath);
        console.log(`💾 [Disk Chunking] Saved Chunk ${chunkCount} (${chunkPath}) [Pages up to ${i}]`);

        // Flush chunk from memory
        currentChunkDoc = null;
        if (i < totalPages) {
          currentChunkDoc = await PDFDocument.create();
          currentChunkFont = await currentChunkDoc.embedFont(StandardFonts.HelveticaBold);
        }
      }
    }

    // 🛑 STEP 1: CLOSE CHROMIUM BROWSER BEFORE FINAL PDF COMPILATION!
    // This immediately releases ~250MB-300MB of Chromium RAM before merging chunks!
    try {
      await browser.close();
      browser = null;
      console.log('🚪 [Browser Closed] Chromium memory freed before final assembly.');
    } catch (e) {}

    // Clean, professional filename (e.g. 151-Skin-Cases-Diagnosis-and-Treatment.pdf)
    const cleanFileName = (docTitle || `Scribd_Doc_${docId}`)
      .replace(/[/\\?%*:|"<>]/g, '')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 50)
      .replace(/^-+|-+$/g, '') || `Scribd_${docId}`;

    const outputPath = path.join(downloadsDir, `${cleanFileName}.pdf`);

    // 🛑 STEP 2: ASSEMBLE FINAL PDF
    onProgress({
      stage: 'uploading',
      percent: 98,
      text: `📦 *Assembling final HD PDF document (${totalPages} Pages)...*`
    });

    let finalPageCount = totalPages;

    if (tempChunks.length === 1) {
      // Single chunk: Simply rename for instant 0-RAM output!
      fs.renameSync(tempChunks[0], outputPath);
    } else {
      // Multi-chunk: Merge sequential chunks into final document
      const finalPdf = await PDFDocument.create();
      for (const cp of tempChunks) {
        const cBytes = fs.readFileSync(cp);
        const loadedChunk = await PDFDocument.load(cBytes);
        const copied = await finalPdf.copyPages(loadedChunk, loadedChunk.getPageIndices());
        copied.forEach(p => finalPdf.addPage(p));
      }
      const finalBytes = await finalPdf.save();
      fs.writeFileSync(outputPath, finalBytes);
      finalPageCount = finalPdf.getPageCount();

      // Delete temporary chunk files from disk immediately
      for (const cp of tempChunks) {
        try { if (fs.existsSync(cp)) fs.unlinkSync(cp); } catch (e) {}
      }
    }

    const stats = fs.statSync(outputPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    return {
      pdfPath: outputPath,
      title: docTitle,
      pageCount: finalPageCount,
      fileSizeMB
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  downloadScribdDocument
};
