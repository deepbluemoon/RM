FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache bash docker-cli docker-cli-compose
COPY package.json ./
COPY src ./src
COPY docs ./docs
COPY scripts ./scripts
RUN chmod +x scripts/*.sh
ENV NODE_ENV=production OPS_DASHBOARD_HOST=0.0.0.0
EXPOSE 9760
CMD ["node", "src/server.mjs"]
