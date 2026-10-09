FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
ENV NODE_ENV=production NODE_NO_WARNINGS=1 PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY data ./data
COPY --from=build /build/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/server.js"]
