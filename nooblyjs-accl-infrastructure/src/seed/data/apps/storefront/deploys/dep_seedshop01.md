---
id: dep_seedshop01
app: storefront
trigger: push
by: { id: 'git:stevie', name: stevie }
commit: a1f3c9e
message: Faster product images
status: live
step: 9
of: 9
operation: null
startedAt: '{{ago:13m}}'
endedAt: '{{ago:12m}}'
---
{{ago:13m}}  stevie/storefront @ main · a1f3c9e Faster product images → web-01
{{ago:13m}}  Cloned a1f3c9e: Faster product images (with the Git connection’s token, removed after)
{{ago:13m}}  #1 [internal] load build definition from Dockerfile
{{ago:13m}}  #2 [1] FROM node:22-alpine
{{ago:13m}}  #6 [5] RUN npm ci --omit=dev
{{ago:12m}}  #9 naming to docker.io/noobly-app/storefront:a1f3c9e00000 done
{{ago:12m}}  3 variables in /srv/apps/storefront/.env (0600)
{{ago:12m}}  Started storefront-a1f3c9e-op01 on 127.0.0.1:30000 beside the version serving now
{{ago:12m}}  GET /healthz answered 200 after 2 s
{{ago:12m}}  https://shop.example.com now goes to storefront-a1f3c9e-op01
{{ago:12m}}  Stopped storefront-9c04e1a-k2m8
