FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 4173
VOLUME ["/app/data"]
CMD ["node","server.js"]
