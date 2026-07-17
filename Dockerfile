# syntax=docker/dockerfile:1
# Node / TypeScript CLI image. Build + runtime go through script/* (npm).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/scripts/parsed-cleanup-fs.py ./scripts/parsed-cleanup-fs.py
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]
