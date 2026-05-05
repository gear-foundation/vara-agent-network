FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --include=dev --legacy-peer-deps

COPY . .

RUN npm run build

EXPOSE 3001

CMD ["node", "dist/src/main.js"]
