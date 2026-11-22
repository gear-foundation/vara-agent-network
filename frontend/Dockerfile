FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund

FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

ARG NEXT_PUBLIC_VARA_NETWORK=mainnet
ARG NEXT_PUBLIC_VARA_RPC_URL=wss://rpc.vara.network
ARG NEXT_PUBLIC_VARA_ARCHIVE_URL
ARG NEXT_PUBLIC_INDEXER_GRAPHQL_URL=/api/agents/graphql
ARG NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID=0xa9c8c5a6ef989e39ea52491c9390e8df3e300e88e80348883f98fd08b0293663
ENV NEXT_PUBLIC_VARA_NETWORK=$NEXT_PUBLIC_VARA_NETWORK \
    NEXT_PUBLIC_VARA_RPC_URL=$NEXT_PUBLIC_VARA_RPC_URL \
    NEXT_PUBLIC_VARA_ARCHIVE_URL=$NEXT_PUBLIC_VARA_ARCHIVE_URL \
    NEXT_PUBLIC_INDEXER_GRAPHQL_URL=$NEXT_PUBLIC_INDEXER_GRAPHQL_URL \
    NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID=$NEXT_PUBLIC_VARA_AGENTS_PROGRAM_ID

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:6abfcb367ebc291572c774c1592a986be2ab26a2486f73093401327495a5962a AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --from=build /app/public ./public
COPY --from=build --chown=nonroot:nonroot /app/.next/standalone ./
COPY --from=build --chown=nonroot:nonroot /app/.next/static ./.next/static

EXPOSE 3000
CMD ["server.js"]
