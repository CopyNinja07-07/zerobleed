# ZeroBleed: API on :8000, dashboard on :3030, data silos on :8787.
# Zetaris and Meterless Nightshift run on the host; inside the container use
# host.docker.internal in .env (see .env.example). No GPU needed.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production PORT=8000 DASHBOARD_PORT=3030 DATA_PORT=8787

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY . .
RUN mkdir -p logs runs

EXPOSE 8000 3030 8787
CMD ["npm", "start"]
