FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=8080
# Optional shared secret – set at deploy time:
# ENV RENDERER_KEY=change-me

EXPOSE 8080
CMD ["node", "server.js"]
