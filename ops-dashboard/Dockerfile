FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
RUN chmod +x scripts/*.sh
ENV NODE_ENV=production
EXPOSE 9760
CMD ["node", "src/server.mjs"]
