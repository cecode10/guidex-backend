# guidex-backend

## Lambda handlers
- `lambdas/guidex-text-prompt-lambda.mjs` -> `dist/guidex-text-prompt-lambda.js` (`handler`)
- `lambdas/guidex-image-annotation-lambda.mjs` -> `dist/guidex-image-annotation-lambda.js` (`handler`)
- `lambdas/guidex-image-recognition-lambda.mjs` -> `dist/guidex-image-recognition-lambda.js` (`handler`)
- `lambdas/guidex-text-to-speech-lambda.mjs` -> `dist/guidex-text-to-speech-lambda.js` (`handler`)

## Environment
- `GOOGLE_TTS_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS_JSON`
  - Stringified JSON for a Google service account with Text-to-Speech access.

## Build
```
npm run build
```

## Deploy
```
npm run deploy
```
