ARG NODE_IMAGE=node:24-bookworm-slim
ARG APT_MIRROR=http://mirrors.ustc.edu.cn
ARG PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright

FROM ${NODE_IMAGE} AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime

ARG APT_MIRROR
ARG PLAYWRIGHT_DOWNLOAD_HOST

WORKDIR /app

ENV PLAYWRIGHT_DOWNLOAD_HOST=${PLAYWRIGHT_DOWNLOAD_HOST}

COPY package.json package-lock.json ./
RUN sed -i \
      -e "s|http://deb.debian.org/debian-security|${APT_MIRROR}/debian-security|g" \
      -e "s|http://deb.debian.org/debian|${APT_MIRROR}/debian|g" \
      /etc/apt/sources.list.d/debian.sources \
    && npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY demo ./demo

ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
