# ⚡ Scribd HD PDF Downloader Telegram Bot

An ultra-high-definition, lossless Scribd PDF Downloader Bot powered by Puppeteer and pdf-lib. Bypasses font obfuscation, prevents margin clipping, captures complete multi-page documents, and adds a clickable branding watermark.

---

## ✨ Features

- 📑 **100% Full Pages:** Downloads all pages in sequence with lazy-load resolving.
- 🎯 **Zero Margin Cutoff:** Uses element-by-element bounding box capture at 2x Retina resolution.
- 🔤 **Crystal Clear Handwriting & Equations:** Bypasses Scribd font scrambling.
- 🖼️ **Full Image & Diagram Settling:** Ensures all illustrations and figures load before capture.
- ⚡ **3-Stage Live Progress UI:** Independent 0%–100% progress for Connecting, Rendering, and Uploading.
- 🛡️ **Anti-Spam & Concurrency Controls:** 1 active download per user with global queue concurrency limits.
- 🧹 **Automatic Storage Cleanup:** Background routine automatically removes PDF cache files older than 30 minutes.
- 🔗 **Clickable Watermark Badge:** Elegant corner badge linked to your Telegram bot.
- 🐳 **Railway / Docker Ready:** Preconfigured `Dockerfile` with Chromium and Unicode/Hindi fonts.

---

## 🚀 Railway Deployment Guide

1. Create a new project on [Railway.app](https://railway.app).
2. Connect your GitHub repository (`ScribdPdfDownloaderBot`).
3. Under **Variables** (Environment Variables), add:
   - `BOT_TOKEN`: Your Telegram Bot token from [@BotFather](https://t.me/BotFather).
   - `MAX_CONCURRENT`: `2` (recommended for standard memory containers).
4. Railway will automatically build using the included `Dockerfile` and start the bot!

---

## 💻 Local Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/strimoflow-ctrl/ScribdPdfDownloaderBot.git
   cd ScribdPdfDownloaderBot
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment:**
   - Copy `.env.example` to `.env`:
     ```bash
     cp .env.example .env
     ```
   - Add your Telegram Bot Token in `.env`:
     ```env
     BOT_TOKEN=123456789:ABCdefYourTokenHere
     ```

4. **Start the Bot:**
   ```bash
   node bot.js
   ```

---

## 👨‍💻 Developer & Credits

- Developed by **[@cryvex4](https://t.me/cryvex4)**
