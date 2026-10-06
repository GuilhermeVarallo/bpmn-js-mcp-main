# nginx de borda do bpmn-js-mcp (cabeçalhos de segurança + proxy SSE).
# Versão fixada FORA da lista vetada pela SI/FGV (nginx 1.27.5 é proibida).
# Conferir na imagem construída:  docker run --rm --entrypoint nginx <imagem> -v
# Contexto de build: a raiz do repositório (docker-compose.yml), para levar public/.
FROM nginxinc/nginx-unprivileged:1.30.5-alpine
COPY deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY public /usr/share/nginx/html
EXPOSE 8080
