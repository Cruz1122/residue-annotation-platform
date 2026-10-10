FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.34.6 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile && chown -R node:node /app

COPY --chown=node:node . .

USER node

EXPOSE 4742

CMD ["./node_modules/.bin/astro", "dev", "--host", "0.0.0.0", "--port", "4742"]
