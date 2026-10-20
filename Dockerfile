# Small image for Fly.io (or any Docker host)
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js gamedata.js guns.json ./
COPY client ./client
ENV NODE_ENV=production PORT=8080 TRUST_PROXY=1
EXPOSE 8080
USER node
CMD ["node", "server.js"]
