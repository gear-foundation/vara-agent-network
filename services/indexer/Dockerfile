FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY services/indexer/package.json services/indexer/package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/package.json /app/package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY services/indexer/tsconfig.json ./tsconfig.json
COPY services/indexer/drizzle.config.ts ./drizzle.config.ts
COPY services/indexer/drizzle ./drizzle
COPY services/indexer/src ./src
COPY programs/agents-network/client/agents_network_client.idl ./idl/agents_network_client.idl
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    API_PORT=4350

RUN addgroup --system --gid 1001 app \
 && adduser  --system --uid 1001 --ingroup app app

COPY --from=build --chown=app:app /app/package.json /app/package-lock.json ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/lib ./lib
COPY --from=build --chown=app:app /app/drizzle ./drizzle
COPY --from=build --chown=app:app /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build --chown=app:app /app/src ./src
COPY --from=build --chown=app:app /app/idl ./idl

USER app
EXPOSE 4350
CMD ["npm", "run", "serve"]
