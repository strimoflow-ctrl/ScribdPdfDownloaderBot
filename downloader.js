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
 * Add a prominent, beautiful and clickable watermark badge to a PDF page
 * Perfectly visible on mobile and desktop without covering core notes
 */
function addClickableWatermark(pdfDoc, page, font, botUsername = 'ScribdPdfDownloaderBot') {
  const { width } = page.getSize();
  const text = `Downloaded via @${botUsername}`;

  // Proportional font sizing: large & clear on Retina/2x scale canvases
  const fontSize = Math.max(18, Math.min(30, Math.round(width * 0.020)));
  const textWidth = font.widthOfTextAtSize(text, fontSize);
  const paddingX = Math.round(fontSize * 0.75);
  const badgeWidth = textWidth + paddingX * 2;
  const badgeHeight = Math.round(fontSize * 1.75);

  // Position at bottom-right corner with comfortable margin
  const margin = Math.round(fontSize * 0.8);
  const x = width - badgeWidth - margin;
  const y = margin;

  // Dark pill container with vibrant blue outline
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

  // Sharp text
  page.drawText(text, {
    x: x + paddingX,
    y: y + Math.round((badgeHeight - fontSize) / 2) + 1,
    size: fontSize,
    font,
    color: rgb(0.95, 0.97, 1.0)
  });

  // Clickable Link Annotation
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
 * @param {string} docId - Scribd document ID
 * @param {function} onProgress - Progress status callback
 * @param {string} botUsername - For clickable watermark
 * @returns {Promise<{ pdfPath: string, title: string, pageCount: number, fileSizeMB: string }>}
 */
async function downloadScribdDocument(docId, onProgress = () => {}, botUsername = 'ScribdPdfDownloaderBot') {
  const executablePath = getBrowserExecutablePath();
  const downloadsDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  // Stage 1: Connecting (0% -> 100%)
  onProgress({
    stage: 'connecting',
    percent: 20,
    text: '🚀 *Launching browser engine...*'
  });

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1400,1800'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1800, deviceScaleFactor: 2 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    onProgress({
      stage: 'connecting',
      percent: 60,
      text: '🔍 *Connecting to Scribd secure server...*'
    });

    const embedUrl = `https://www.scribd.com/embeds/${docId}/content?start_page=1&view_mode=scroll`;
    await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    onProgress({
      stage: 'connecting',
      percent: 100,
      text: '✅ *Connected! Initializing pages...*'
    });

    // Wait 3 seconds for Scribd components to initialize
    await new Promise(r => setTimeout(r, 3000));

    // Extract title
    let docTitle = await page.evaluate(() => {
      const titleEl = document.querySelector('title') || document.querySelector('.document_title');
      return titleEl ? titleEl.textContent.replace(/Scribd/i, '').trim() : '';
    });
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

    // Hide only extraneous UI toolbars (DO NOT touch anchor tags or images)
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

    const pdfDoc = await PDFDocument.create();
    const watermarkFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const useJpeg = totalPages > 25;

    // Stage 2: Rendering Pages (0% -> 100%)
    for (let i = 1; i <= totalPages; i++) {
      const renderPercent = Math.round((i / totalPages) * 100);

      onProgress({
        stage: 'rendering',
        percent: renderPercent,
        currentPage: i,
        totalPages,
        title: docTitle,
        text: `⚡ *Rendering:* Page ${i} of ${totalPages}`
      });

      // Scroll into view & wait for all images on this page to completely finish loading
      await page.evaluate(async (idx) => {
        const el = document.getElementById(`outer_page_${idx}`);
        if (!el) return;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });

        // Trigger any lazy-loaded image sources
        const imgs = Array.from(el.querySelectorAll('img'));
        for (const img of imgs) {
          if (!img.src && img.dataset.src) {
            img.src = img.dataset.src;
          }
          img.style.opacity = '1';
          img.style.visibility = 'visible';
        }

        // Wait for all images in this page container to settle
        await Promise.all(imgs.map(img => {
          if (img.complete && img.naturalWidth > 0) return Promise.resolve();
          return new Promise(resolve => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
            setTimeout(resolve, 2000); // Max 2s timeout per image
          });
        }));
      }, i);

      // Brief settling pause for vector fonts and graphics
      await new Promise(r => setTimeout(r, 650));

      const pageElement = await page.$(`#outer_page_${i}`);
      if (!pageElement) {
        console.warn(`Page element #outer_page_${i} missing, skipping...`);
        continue;
      }

      let imgBuffer;
      let embeddedImage;

      if (useJpeg) {
        imgBuffer = await pageElement.screenshot({ type: 'jpeg', quality: 92 });
        embeddedImage = await pdfDoc.embedJpg(imgBuffer);
      } else {
        imgBuffer = await pageElement.screenshot({ type: 'png', omitBackground: false });
        embeddedImage = await pdfDoc.embedPng(imgBuffer);
      }

      const pdfPage = pdfDoc.addPage([embeddedImage.width, embeddedImage.height]);
      pdfPage.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width: embeddedImage.width,
        height: embeddedImage.height
      });

      // Add large, clear, clickable watermark badge
      addClickableWatermark(pdfDoc, pdfPage, watermarkFont, botUsername);
    }

    const pdfBytes = await pdfDoc.save();
    const outputPath = path.join(downloadsDir, `${safeTitle}_${docId}.pdf`);
    fs.writeFileSync(outputPath, pdfBytes);

    const stats = fs.statSync(outputPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    return {
      pdfPath: outputPath,
      title: docTitle,
      pageCount: pdfDoc.getPageCount(),
      fileSizeMB
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  downloadScribdDocument
};
