FROM node:18-slim
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .
# dashboard is mounted at runtime via docker-compose volume
CMD ["node", "server.js"]
