FROM node:22-alpine
RUN apk add --no-cache git \
 # The vault on the NFS share is owned by a NAS user, not by the container user.
 && git config --system safe.directory '*'
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
COPY vault.gitignore ./
ENV VAULT_PATH=/vault
ENTRYPOINT ["node", "/app/bin/vaultsync.js"]
CMD ["watch"]
