FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY services/indexer/package.json services/indexer/package-lock.json ./
RUN npm ci

COPY services/indexer/tsconfig.json ./tsconfig.json
COPY services/indexer/drizzle.config.ts ./drizzle.config.ts
COPY services/indexer/drizzle ./drizzle
COPY services/indexer/src ./src
COPY programs/agents-network/client/agents_network_client.idl ./idl/agents_network_client.idl

RUN npm run build

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/lib ./lib
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/src ./src
COPY --from=build /app/idl ./idl

EXPOSE 4350

CMD ["npm", "run", "start:api"]
