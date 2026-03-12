FROM node:18-slim
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .
COPY alerter.js .
COPY dashboard ./dashboard
EXPOSE 3000
CMD ["node", "server.js"]
