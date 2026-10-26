# Two stages. The first turns the React source into plain files; the second keeps
# only those files and a web server. Node never reaches the running container.

FROM node:22-alpine AS build
WORKDIR /app

# package.json and the lockfile first, on their own layer: they change far less
# often than the source, so npm ci is skipped on most rebuilds.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vite reads VITE_* variables at build time and writes the values into the bundle,
# so the API address is chosen here, not when the container starts.
ARG VITE_API_URL=https://api.myrelay.tech
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
