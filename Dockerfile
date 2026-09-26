FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY deployment/openclaw/channel-policy ./deployment/openclaw/channel-policy
RUN npm run check

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production DATA_DIR=/app/data TZ=Europe/Warsaw
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir -p /app/data && chown node:node /app/data
COPY --from=build /app/dist ./dist
USER node
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
