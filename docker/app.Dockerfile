FROM node:24.22.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
COPY templates templates
RUN pnpm build

FROM node:24.22.0-bookworm-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data WEB_DIR=/app/apps/web/dist
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
