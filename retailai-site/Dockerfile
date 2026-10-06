# syntax=docker/dockerfile:1

FROM node:22-alpine AS dependencies

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app
COPY --from=dependencies /app/server/node_modules ./server/node_modules
COPY server ./server
COPY index.html ./index.html
COPY assets ./assets
COPY Data ./Data

WORKDIR /app/server
USER node
EXPOSE 3000

CMD ["node", "index.js"]