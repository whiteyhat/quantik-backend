FROM node:20-slim

RUN apt-get update && apt-get install -y curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Install Polymarket CLI
RUN curl -sSL https://raw.githubusercontent.com/Polymarket/polymarket-cli/main/install.sh | sh

ENV PATH="/root/.local/bin:${PATH}"
ENV POLYMARKET_CLI="/root/.local/bin/polymarket"

WORKDIR /app

# Install ALL deps (including devDeps) for build step
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Prune devDeps after build
RUN npm prune --production

EXPOSE 3001
CMD ["npm", "start"]
