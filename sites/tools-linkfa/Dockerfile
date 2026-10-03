# tools.linkfa.de: the tools' tests run first and a failure stops the deploy;
# then the site is built to static HTML and served by nginx.
FROM node:22-alpine AS build
WORKDIR /site
COPY . .
RUN node --test && node build.mjs --out dist

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site/dist /usr/share/nginx/html
EXPOSE 80
