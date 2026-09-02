FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js access-db.js admin-db.js analytics.js metrics.js retention.js retention-runner.js logic.js email.js demo-seed.js demo-club.js demo-scope.js ./
COPY routes/ ./routes/
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]