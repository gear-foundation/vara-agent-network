FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS build
WORKDIR /app
COPY services/indexer/package.json services/indexer/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/indexer/tsconfig.json ./tsconfig.json
COPY services/indexer/src ./src
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:6abfcb367ebc291572c774c1592a986be2ab26a2486f73093401327495a5962a AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    API_PORT=4350

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/lib ./lib
COPY services/indexer/drizzle ./drizzle
COPY programs/agents-network/client/agents_network_client.idl ./idl/agents_network_client.idl

EXPOSE 4350
CMD ["lib/api/main.js"]
