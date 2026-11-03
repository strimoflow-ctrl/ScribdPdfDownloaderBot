const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_FILE = path.join(__dirname, 'cache.json');

class CacheManager {
  constructor() {
    this.cache = this._load();
  }

  _load() {
    if (fs.existsSync(CACHE_FILE)) {
      try {
        const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
        return JSON.parse(raw);
      } catch (e) {
        console.warn('⚠️ [CacheManager] Could not read cache.json, starting fresh:', e.message);
      }
    }
    return { docs: {} };
  }

  _save() {
    try {
      const tempPath = CACHE_FILE + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(this.cache, null, 2), 'utf-8');
      if (fs.existsSync(CACHE_FILE)) {
        fs.renameSync(tempPath, CACHE_FILE);
      } else {
        fs.renameSync(tempPath, CACHE_FILE);
      }
    } catch (e) {
      console.warn('⚠️ [CacheManager] Save cache error:', e.message);
    }
  }

  getDoc(docId) {
    return this.cache.docs[docId] || null;
  }

  saveDocMeta(docId, title, totalPages, totalParts = 1, partSize = 250) {
    if (!this.cache.docs[docId]) {
      this.cache.docs[docId] = {
        title,
        totalPages,
        totalParts,
        partSize,
        parts: {},
        full_file_id: null,
        created_at: new Date().toISOString()
      };
    } else {
      if (title) this.cache.docs[docId].title = title;
      if (totalPages) this.cache.docs[docId].totalPages = totalPages;
      if (totalParts) this.cache.docs[docId].totalParts = totalParts;
      if (partSize) this.cache.docs[docId].partSize = partSize;
    }
    this._save();
    return this.cache.docs[docId];
  }

  getFullFileId(docId) {
    const doc = this.getDoc(docId);
    return doc ? doc.full_file_id : null;
  }

  saveFullFileId(docId, fileId, title = null, totalPages = null) {
    this.saveDocMeta(docId, title, totalPages, 1);
    this.cache.docs[docId].full_file_id = fileId;
    this.cache.docs[docId].updated_at = new Date().toISOString();
    this._save();
    console.log(`💾 [Smart Cache] Saved full Telegram file_id for Doc ${docId}`);
  }

  getPartFileId(docId, rangeKey) {
    const doc = this.getDoc(docId);
    if (!doc || !doc.parts) return null;
    return doc.parts[rangeKey] || null;
  }

  savePartFileId(docId, rangeKey, fileId, partInfo = {}) {
    if (!this.cache.docs[docId]) {
      this.saveDocMeta(docId, partInfo.title, partInfo.totalPages, partInfo.totalParts, partInfo.partSize);
    }
    if (!this.cache.docs[docId].parts) {
      this.cache.docs[docId].parts = {};
    }
    this.cache.docs[docId].parts[rangeKey] = fileId;
    this.cache.docs[docId].updated_at = new Date().toISOString();
    this._save();
    console.log(`💾 [Smart Cache] Saved Part [${rangeKey}] Telegram file_id for Doc ${docId}`);
  }

  // 🧹 System Cleaner: Purges temporary chromium profiles and old download files
  cleanSystemTemp() {
    try {
      const tempDir = os.tmpdir();
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        for (const file of files) {
          if (file.startsWith('puppeteer_dev_chrome_profile') || file.startsWith('.org.chromium.')) {
            const fullPath = path.join(tempDir, file);
            try {
              fs.rmSync(fullPath, { recursive: true, force: true });
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }
}

const cacheManager = new CacheManager();
module.exports = { cacheManager };

