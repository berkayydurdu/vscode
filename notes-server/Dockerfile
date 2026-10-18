FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV HOST=0.0.0.0 PORT=8787 NOTES_DB=/data/notes.db
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "src/main.ts"]
