# ---- build: typecheck shared, build client (PWA) and bundle server ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: production deps + built artefacts only ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --omit=dev --workspace=@washlog/server && npm cache clean --force
COPY server/migrations server/migrations
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server/dist/index.js"]
