FROM node:20-slim

# Install Chromium and essential fonts for crystal clear Hindi & equations
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    fonts-dejavu-core \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "bot.js"]
