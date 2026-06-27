# ramblex-backend

## Authentication

All Lambda handlers require a valid Firebase ID token in the `Authorization: Bearer <token>` header. The mobile app must obtain the token via `FirebaseAuth.instance.currentUser?.getIdToken()` and include it in every request. Invalid or missing tokens return `401 Unauthorized` with `{"error":"unauthorized"}`.

## Lambda handlers
- `lambdas/ramblex-text-prompt-lambda.mjs` -> `dist/ramblex-text-prompt-lambda.js` (`handler`)
- `lambdas/ramblex-image-annotation-lambda.mjs` -> `dist/ramblex-image-annotation-lambda.js` (`handler`)
- `lambdas/ramblex-image-recognition-lambda.mjs` -> `dist/ramblex-image-recognition-lambda.js` (`handler`)
- `lambdas/ramblex-text-to-speech-lambda.mjs` -> `dist/ramblex-text-to-speech-lambda.js` (`handler`)

## Environment

### Required for all Lambdas (Firebase Auth)
- `FIREBASE_PROJECT_ID` – Firebase project ID (e.g. `guidex-afc30`). Used to validate Firebase ID tokens. Set this on each Lambda's environment configuration.

## Build
```
npm run build
```

## Deploy
```
npm run deploy
```
