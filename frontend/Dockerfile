FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

ARG NEXT_PUBLIC_VARA_NETWORK=testnet
ARG NEXT_PUBLIC_VARA_RPC_URL=wss://testnet-archive.vara.network
ARG NEXT_PUBLIC_VARA_ARCHIVE_URL
ARG NEXT_PUBLIC_INDEXER_GRAPHQL_URL=/api/agents/graphql
ARG NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID=0x99ba7698c735c57fc4e7f8cd343515fc4b361b2d70c62ca640f263441d1e9686
ENV NEXT_PUBLIC_VARA_NETWORK=$NEXT_PUBLIC_VARA_NETWORK \
    NEXT_PUBLIC_VARA_RPC_URL=$NEXT_PUBLIC_VARA_RPC_URL \
    NEXT_PUBLIC_VARA_ARCHIVE_URL=$NEXT_PUBLIC_VARA_ARCHIVE_URL \
    NEXT_PUBLIC_INDEXER_GRAPHQL_URL=$NEXT_PUBLIC_INDEXER_GRAPHQL_URL \
    NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID=$NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 app \
 && adduser  --system --uid 1001 --ingroup app app

COPY --from=build /app/public ./public
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static

USER app
EXPOSE 3000
CMD ["node", "server.js"]
