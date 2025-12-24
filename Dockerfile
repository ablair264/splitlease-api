FROM node:20-slim

# Install dependencies for Playwright
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (need TypeScript for build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Install Playwright Chromium browser
RUN npx playwright install chromium

# Remove dev dependencies
RUN npm prune --omit=dev

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "dist/index.js"]
