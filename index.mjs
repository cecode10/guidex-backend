import { initializeApp } from "firebase-admin/app";

initializeApp();

export { textPrompt } from "./handlers/text-prompt.mjs";
export { imageAnnotation } from "./handlers/image-annotation.mjs";
export { imageRecognition } from "./handlers/image-recognition.mjs";
export { textToSpeechFn as textToSpeech } from "./handlers/text-to-speech.mjs";
export { deleteAccount } from "./handlers/delete-account.mjs";
export { onUserProfileUpdate } from "./handlers/on-user-profile-update.mjs";
export { resolvePlaceImage } from "./handlers/resolve-place-image.mjs";
export { resolveSearchAnchor } from "./handlers/resolve-search-anchor.mjs";

