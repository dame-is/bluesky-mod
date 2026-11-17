FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY config/bot.example.json ./config/bot.example.json

# The database, the session and the Jetstream cursor live here. Mount a
# volume, or every restart starts from nothing.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
