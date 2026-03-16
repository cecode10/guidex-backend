import { getFirestore, FieldValue } from "firebase-admin/firestore";

export const EVENT_TYPES = {
    TEXT_PROMPT: "TEXT_PROMPT",
    TTS_REQUEST: "TTS_REQUEST",
    IMAGE_RECOGNITION: "IMAGE_RECOGNITION",
    IMAGE_ANNOTATION: "IMAGE_ANNOTATION",
    NEW_REGISTRATION: "NEW_REGISTRATION",
};

const COUNTER_FIELD = {
    [EVENT_TYPES.TEXT_PROMPT]: "textPrompts",
    [EVENT_TYPES.TTS_REQUEST]: "ttsRequests",
    [EVENT_TYPES.IMAGE_RECOGNITION]: "imageRecognitions",
    [EVENT_TYPES.IMAGE_ANNOTATION]: "imageAnnotations",
    [EVENT_TYPES.NEW_REGISTRATION]: "newRegistrations",
};

const db = () => getFirestore();

const dateKeys = (now = new Date()) => ({
    daily: `daily_${now.toISOString().slice(0, 10)}`,
    monthly: `monthly_${now.toISOString().slice(0, 7)}`,
});

const buildCounterUpdates = (eventType, { persona, language, isNewChat } = {}) => {
    const updates = {};

    const field = COUNTER_FIELD[eventType];
    if (field) updates[field] = FieldValue.increment(1);

    if (persona) {
        updates.personas = { [persona]: FieldValue.increment(1) };
    }
    if (language) {
        updates.languages = { [language]: FieldValue.increment(1) };
    }

    if (eventType === EVENT_TYPES.TEXT_PROMPT) {
        updates.totalMessages = FieldValue.increment(1);
        if (isNewChat) updates.totalChats = FieldValue.increment(1);
    }

    return updates;
};

/**
 * Fire-and-forget: writes a raw event doc and increments daily/monthly/global counters.
 * Never throws — errors are logged and swallowed so analytics can't break API responses.
 */
export const trackEvent = (eventType, data = {}) => {
    const { uid, persona, language, isNewChat, ...extra } = data;
    const { daily, monthly } = dateKeys();
    const store = db();

    const rawEvent = {
        eventType,
        timestamp: FieldValue.serverTimestamp(),
        ...(uid && { uid }),
        ...(persona && { persona }),
        ...(language && { language }),
        ...(isNewChat !== undefined && { isNewChat }),
        ...extra,
    };

    const counters = buildCounterUpdates(eventType, { persona, language, isNewChat });

    Promise.all([
        store.collection("analytics_events").add(rawEvent),
        store.doc(`analytics/${daily}`).set(counters, { merge: true }),
        store.doc(`analytics/${monthly}`).set(counters, { merge: true }),
        store.doc("analytics/global").set(counters, { merge: true }),
    ]).catch(err => console.error("analytics: trackEvent failed", err));
};

/**
 * Fire-and-forget: on first ever API call for a uid, records a NEW_REGISTRATION event.
 * Uses a known_users/{uid} doc as a lightweight existence check.
 */
export const checkNewUser = (uid) => {
    const store = db();
    const docRef = store.doc(`known_users/${uid}`);
    docRef.get()
        .then(snap => {
            if (!snap.exists) {
                docRef.set({ firstSeen: FieldValue.serverTimestamp() });
                trackEvent(EVENT_TYPES.NEW_REGISTRATION, { uid });
            }
        })
        .catch(err => console.error("analytics: checkNewUser failed", err));
};
