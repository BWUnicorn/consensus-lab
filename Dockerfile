FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js app.js index.html styles.css logo.svg ./

ENV NODE_ENV=production
ENV PORT=4173

EXPOSE 4173

CMD ["node", "server.js"]
