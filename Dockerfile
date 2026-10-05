FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=optional --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 4173
VOLUME ["/app/data"]
CMD ["node","server.js"]
