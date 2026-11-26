#!/usr/bin/env sh
# Gera o certificado TLS do PostgreSQL (uma vez, na VPS, antes do primeiro "up").
set -eu
cd "$(dirname "$0")"
mkdir -p certs
openssl req -new -x509 -days 3650 -nodes \
  -subj "/CN=cortador-postgres" \
  -keyout certs/server.key -out certs/server.crt
# O PostgreSQL (usuário 70 na imagem alpine) exige a chave legível só por ele.
chown 70:70 certs/server.key certs/server.crt
chmod 600 certs/server.key
echo "Certificado criado em deploy/vps/certs/"
