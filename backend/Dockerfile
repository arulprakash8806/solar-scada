FROM node:18-slim
WORKDIR /app
# Build context is the solar-scada root (set in fly.toml)
COPY backend/package.json .
RUN npm install --production
COPY backend/server.js .
COPY dashboard ./dashboard
EXPOSE 3000
CMD ["node", "server.js"]
