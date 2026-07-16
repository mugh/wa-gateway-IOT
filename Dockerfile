FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

# Folder ini akan di-mount sebagai volume agar session WA persist
RUN mkdir -p /app/auth_session

EXPOSE 3000

CMD ["node", "src/server.js"]
