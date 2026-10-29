FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node sandbox ./sandbox
USER node
CMD ["node", "sandbox/main.js"]
