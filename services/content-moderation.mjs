/**
 * Text and image moderation for public check-ins and profile fields.
 * Callers pass an OpenAI client and a storage/firestore adapter so tests
 * can run without Firebase.
 */

export const MODERATION_MODEL = "omni-moderation-latest";
export const CONTENT_REJECTED = "content_rejected";
export const DELETE_FIELD = Symbol("deleteField");
export const MAX_MODERATION_ATTEMPTS = 8;
export const MAX_CHECKIN_MESSAGE_CHARS = 2500;
export const MAX_ABOUT_CHARS = 5000;
export const MAX_USERNAME_CHARS = 80;
export const MIN_USERNAME_CHARS = 4;

const IMAGE_CONTENT_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
]);

export class ModerationHttpError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

export const buildUserSearchPrefixes = ({
    username,
    displayName,
    minPrefixLength = MIN_USERNAME_CHARS,
} = {}) => {
    const prefixes = new Set();
    const addPrefixesForText = (text) => {
        const lower = typeof text === "string" ? text.trim().toLowerCase() : "";
        if (!lower) return;
        for (let i = minPrefixLength; i <= lower.length; i += 1) {
            prefixes.add(lower.slice(0, i));
        }
        for (const word of lower.split(/\s+/)) {
            if (!word) continue;
            for (let i = minPrefixLength; i <= word.length; i += 1) {
                prefixes.add(word.slice(0, i));
            }
        }
    };
    addPrefixesForText(username);
    addPrefixesForText(displayName);
    return [...prefixes];
};

export const buildModerationInput = ({ text, imageDataUrl } = {}) => {
    const input = [];
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed) {
        input.push({ type: "text", text: trimmed });
    }
    if (typeof imageDataUrl === "string" && imageDataUrl.startsWith("data:image/")) {
        input.push({ type: "image_url", image_url: { url: imageDataUrl } });
    }
    return input;
};

export const isModerationOutage = (error) => {
    const status = error?.status ?? error?.statusCode;
    if (status == null) return true;
    if (status === 408 || status === 429) return true;
    return status >= 500;
};

export const decisionFromModerationResponse = (response) => {
    const result = response?.results?.[0];
    const model = response?.model || MODERATION_MODEL;
    if (!result) {
        return { status: "pending", categories: [], sexualMinors: false, model };
    }
    const categories = Object.entries(result.categories || {})
        .filter(([, flagged]) => flagged === true)
        .map(([name]) => name);
    if (!result.flagged || categories.length === 0) {
        return { status: "approved", categories: [], sexualMinors: false, model };
    }
    return {
        status: "rejected",
        categories,
        sexualMinors: categories.includes("sexual/minors"),
        model,
    };
};

export const moderateUserContent = async (client, { text, imageDataUrl } = {}) => {
    const input = buildModerationInput({ text, imageDataUrl });
    if (input.length === 0) {
        return {
            status: "approved",
            categories: [],
            sexualMinors: false,
            model: MODERATION_MODEL,
        };
    }
    try {
        const response = await client.moderations.create({
            model: MODERATION_MODEL,
            input,
        });
        return decisionFromModerationResponse(response);
    } catch (error) {
        if (isModerationOutage(error)) {
            return {
                status: "pending",
                categories: [],
                sexualMinors: false,
                model: MODERATION_MODEL,
            };
        }
        throw error;
    }
};

const ALLOWED_PROFILE_PHOTO_HOSTS = [
    "googleusercontent.com",
    "ggpht.com",
    "facebook.com",
    "fbcdn.net",
    "fbsbx.com",
];

export const isAllowedProfilePhotoUrl = (value) => {
    if (typeof value !== "string" || !value) return false;
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_PROFILE_PHOTO_HOSTS.some(
        (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    );
};

export const assertOwnedStoragePath = (uid, storagePath) => {
    if (storagePath == null || storagePath === "") return null;
    if (typeof storagePath !== "string") {
        throw new ModerationHttpError(400, "invalid storage path");
    }
    const normalized = storagePath.replace(/^\/+/, "");
    if (normalized.includes("..") || normalized.includes("//")) {
        throw new ModerationHttpError(400, "invalid storage path");
    }
    const prefix = `users/${uid}/`;
    if (!normalized.startsWith(prefix)) {
        throw new ModerationHttpError(400, "invalid storage path");
    }
    return normalized;
};

const requireString = (value, { max, field, allowEmpty = false }) => {
    if (value == null) {
        if (allowEmpty) return "";
        throw new ModerationHttpError(400, `${field} is required`);
    }
    if (typeof value !== "string") {
        throw new ModerationHttpError(400, `${field} is invalid`);
    }
    const trimmed = value.trim();
    if (!allowEmpty && !trimmed) {
        throw new ModerationHttpError(400, `${field} is required`);
    }
    if (trimmed.length > max) {
        throw new ModerationHttpError(400, `${field} is too long`);
    }
    return trimmed;
};

const optionalBoundedString = (value, max, field) => {
    if (value == null || value === "") return null;
    return requireString(value, { max, field });
};

export const moderationStamp = ({ status, model, categories = [], storagePath = null, attempts = 1, pending = null, serverTimestamp }) => {
    const stamp = {
        status,
        model: model || MODERATION_MODEL,
        categories,
        attempts,
        checkedAt: serverTimestamp,
    };
    if (storagePath) stamp.storagePath = storagePath;
    if (pending) stamp.pending = pending;
    return stamp;
};

const reviewBase = ({ surface, uid, decision, serverTimestamp }) => ({
    surface,
    userId: uid,
    status: "rejected",
    categories: decision.categories,
    model: decision.model || MODERATION_MODEL,
    checkedAt: serverTimestamp,
});

export const checkInReviewDocument = ({ uid, decision, checkIn, serverTimestamp }) => {
    const base = reviewBase({
        surface: "checkin",
        uid,
        decision,
        serverTimestamp,
    });
    if (decision.sexualMinors) return base;
    return {
        ...base,
        message: checkIn.message ?? "",
        locationName: checkIn.locationName ?? "",
        imageUrl: checkIn.imageUrl ?? null,
        storagePath: checkIn.storagePath ?? null,
    };
};

export const profileReviewDocument = ({ uid, decision, proposed, serverTimestamp }) => {
    const base = reviewBase({
        surface: "profile",
        uid,
        decision,
        serverTimestamp,
    });
    if (decision.sexualMinors) return base;
    return {
        ...base,
        username: proposed.username ?? null,
        about: proposed.about ?? null,
        photoUrl: proposed.photoUrl ?? null,
        storagePath: proposed.storagePath ?? null,
    };
};

const profileSnapshot = (data) => {
    const source = data || {};
    return {
        username: source.username ?? null,
        usernameLower: source.usernameLower ?? null,
        about: source.about ?? null,
        photoUrl: source.photoUrl ?? null,
        displayNameLower: source.displayNameLower ?? null,
        searchWordPrefixes: Array.isArray(source.searchWordPrefixes)
            ? [...source.searchWordPrefixes]
            : null,
    };
};

export const restoreProfileFields = (previous) => {
    const source = previous || {};
    const restored = {};
    for (const key of ["username", "usernameLower", "about", "photoUrl", "displayNameLower"]) {
        restored[key] = source[key] == null ? DELETE_FIELD : source[key];
    }
    restored.searchWordPrefixes = source.searchWordPrefixes == null
        ? DELETE_FIELD
        : source.searchWordPrefixes;
    return restored;
};

const parseCheckInInput = (uid, body) => {
    if (!body || typeof body !== "object") {
        throw new ModerationHttpError(400, "invalid payload");
    }
    if (body.userId != null && body.userId !== uid) {
        throw new ModerationHttpError(403, "forbidden");
    }
    const id = requireString(body.id, { max: 128, field: "id" });
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new ModerationHttpError(400, "id is invalid");
    }
    const locationName = requireString(body.locationName, { max: 300, field: "locationName" });
    const message = requireString(body.message ?? "", {
        max: MAX_CHECKIN_MESSAGE_CHARS,
        field: "message",
        allowEmpty: true,
    });
    const locationType = optionalBoundedString(body.locationType, 64, "locationType");
    const isCountryDiscovery = locationType === "COUNTRY_DISCOVERY";
    const storagePath = assertOwnedStoragePath(uid, body.storagePath);
    if (storagePath && !storagePath.startsWith(`users/${uid}/checkins/`)) {
        throw new ModerationHttpError(400, "invalid storage path");
    }
    const imageUrl = resolveCheckInImageUrl({
        storagePath,
        imageUrl: body.imageUrl,
    });
    const countryCodeRaw = optionalBoundedString(body.countryCode, 2, "countryCode");
    const countryCode = countryCodeRaw && countryCodeRaw.length === 2
        ? countryCodeRaw.toUpperCase()
        : null;
    let imageAspectRatio = null;
    if (body.imageAspectRatio != null && imageUrl) {
        const ratio = Number(body.imageAspectRatio);
        if (Number.isFinite(ratio) && ratio > 0 && ratio < 100) {
            imageAspectRatio = ratio;
        }
    }
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const timestampMs = Number(body.timestamp);
    return {
        id,
        locationName,
        message,
        locationType,
        isCountryDiscovery,
        storagePath,
        imageUrl,
        city: optionalBoundedString(body.city, 120, "city"),
        countryCode,
        countryName: optionalBoundedString(body.countryName, 120, "countryName"),
        countryFlag: optionalBoundedString(body.countryFlag, 16, "countryFlag"),
        imageAspectRatio,
        lat: Number.isFinite(lat) ? lat : 0,
        lng: Number.isFinite(lng) ? lng : 0,
        wikidataId: typeof body.wikidataId === "string" && /^Q\d+$/.test(body.wikidataId)
            ? body.wikidataId
            : null,
        discoveredNewLand: body.discoveredNewLand === true,
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
    };
};

export const resolveCheckInImageUrl = ({ storagePath, imageUrl }) => {
    if (imageUrl == null || imageUrl === "") return null;
    if (typeof imageUrl !== "string") {
        throw new ModerationHttpError(400, "imageUrl is invalid");
    }
    const trimmed = imageUrl.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("data:")) {
        throw new ModerationHttpError(400, "imageUrl is invalid");
    }
    if (!trimmed.startsWith("https://")) {
        throw new ModerationHttpError(400, "imageUrl is invalid");
    }
    let decoded = trimmed;
    try {
        decoded = decodeURIComponent(trimmed);
    } catch {
        decoded = trimmed;
    }
    const pointsAtUserStorage = decoded.includes("/users/") || decoded.includes("users/");
    if (storagePath) {
        if (!decoded.includes(storagePath)) {
            throw new ModerationHttpError(400, "imageUrl is invalid");
        }
        return trimmed;
    }
    if (pointsAtUserStorage) {
        throw new ModerationHttpError(400, "imageUrl is invalid");
    }
    return trimmed;
};

const checkInDocument = ({ uid, profile, input, moderation, serverTimestamp }) => {
    const username = (profile?.username || profile?.displayName || "User").toString();
    const userAvatar = profile?.photoUrl || profile?.photoURL || null;
    const doc = {
        id: input.id,
        userId: uid,
        username,
        locationName: input.locationName,
        message: input.message,
        likeCount: 0,
        moderation,
    };
    if (userAvatar) doc.userAvatar = userAvatar;
    if (input.locationType) doc.locationType = input.locationType;
    if (input.city) doc.city = input.city;
    if (input.countryCode) doc.countryCode = input.countryCode;
    if (input.countryName) doc.countryName = input.countryName;
    if (input.countryFlag) doc.countryFlag = input.countryFlag;
    if (input.imageUrl) doc.imageUrl = input.imageUrl;
    if (input.imageAspectRatio != null) doc.imageAspectRatio = input.imageAspectRatio;
    if (input.wikidataId) doc.wikidataId = input.wikidataId;
    if (input.discoveredNewLand) doc.discoveredNewLand = true;
    if (input.timestampMs != null) {
        const maxFuture = Date.now() + 5 * 60 * 1000;
        doc.timestamp = input.timestampMs > maxFuture ? serverTimestamp : new Date(input.timestampMs);
    } else {
        doc.timestamp = serverTimestamp;
    }
    if (!input.isCountryDiscovery) {
        doc.lat = input.lat;
        doc.lng = input.lng;
    }
    return doc;
};

const loadImageDataUrl = async (store, { storagePath, photoUrl }) => {
    if (storagePath) {
        return store.loadStorageImage(storagePath);
    }
    if (photoUrl && isAllowedProfilePhotoUrl(photoUrl)) {
        return store.loadRemoteImage(photoUrl);
    }
    return null;
};

export async function publishCheckIn({ store, moderate, uid, body, serverTimestamp }) {
    const input = parseCheckInInput(uid, body);
    const profile = await store.getUser(uid);
    if (profile?.accountDeleted === true) {
        throw new ModerationHttpError(403, "account deleted");
    }
    let imageDataUrl = null;
    let imageUnavailable = false;
    if (input.storagePath) {
        try {
            imageDataUrl = await loadImageDataUrl(store, { storagePath: input.storagePath });
        } catch (error) {
            if (!isModerationOutage(error)) throw error;
            imageUnavailable = true;
        }
    }
    const decision = await moderate({ text: input.message, imageDataUrl });
    if (imageUnavailable && decision.status === "approved") {
        decision.status = "pending";
    }
    return writeCheckInDecision({
        store,
        uid,
        profile,
        input,
        decision,
        serverTimestamp,
    });
}

async function writeCheckInDecision({ store, uid, profile, input, decision, serverTimestamp }) {
    if (decision.status === "rejected") {
        if (decision.sexualMinors && input.storagePath) {
            await store.deleteStorageImage(input.storagePath);
        }
        await store.addReview(uid, checkInReviewDocument({
            uid,
            decision,
            checkIn: input,
            serverTimestamp,
        }));
        throw new ModerationHttpError(422, CONTENT_REJECTED);
    }
    const moderation = moderationStamp({
        status: decision.status,
        model: decision.model,
        storagePath: input.storagePath,
        serverTimestamp,
    });
    const doc = checkInDocument({
        uid,
        profile,
        input,
        moderation,
        serverTimestamp,
    });
    await store.setCheckIn(uid, input.id, doc);
    return { status: decision.status, id: input.id };
}

const parseProfileInput = (uid, body) => {
    if (!body || typeof body !== "object") {
        throw new ModerationHttpError(400, "invalid payload");
    }
    const hasUsername = Object.prototype.hasOwnProperty.call(body, "username");
    const hasAbout = Object.prototype.hasOwnProperty.call(body, "about");
    const hasPhoto = Object.prototype.hasOwnProperty.call(body, "photoUrl")
        || Object.prototype.hasOwnProperty.call(body, "storagePath");
    if (!hasUsername && !hasAbout && !hasPhoto) {
        throw new ModerationHttpError(400, "nothing to update");
    }
    let username = null;
    if (hasUsername) {
        username = requireString(body.username, { max: MAX_USERNAME_CHARS, field: "username" });
        if (username.length < MIN_USERNAME_CHARS) {
            throw new ModerationHttpError(400, "username is too short");
        }
    }
    let about = null;
    if (hasAbout) {
        about = requireString(body.about ?? "", {
            max: MAX_ABOUT_CHARS,
            field: "about",
            allowEmpty: true,
        });
    }
    const storagePath = assertOwnedStoragePath(uid, body.storagePath);
    if (storagePath && !storagePath.startsWith(`users/${uid}/avatar/`)) {
        throw new ModerationHttpError(400, "invalid storage path");
    }
    let photoUrl = null;
    if (body.photoUrl != null && body.photoUrl !== "") {
        if (typeof body.photoUrl !== "string" || !body.photoUrl.startsWith("https://")) {
            throw new ModerationHttpError(400, "photoUrl is invalid");
        }
        photoUrl = body.photoUrl.trim();
        if (storagePath) {
            let decoded = photoUrl;
            try {
                decoded = decodeURIComponent(photoUrl);
            } catch {
                decoded = photoUrl;
            }
            if (!decoded.includes(storagePath)) {
                throw new ModerationHttpError(400, "photoUrl is invalid");
            }
        } else if (!isAllowedProfilePhotoUrl(photoUrl)) {
            throw new ModerationHttpError(400, "photoUrl is invalid");
        }
    }
    if (storagePath && !photoUrl) {
        throw new ModerationHttpError(400, "photoUrl is required");
    }
    return { username, about, hasAbout, storagePath, photoUrl };
};

const profileTextForModeration = ({ username, about, hasAbout }) => {
    const parts = [];
    if (username) parts.push(username);
    if (hasAbout && about) parts.push(about);
    return parts.join("\n");
};

export async function publishProfileContent({
    store,
    moderate,
    uid,
    body,
    displayName,
    serverTimestamp,
}) {
    const input = parseProfileInput(uid, body);
    const existing = (await store.getUser(uid)) || {};
    if (existing.accountDeleted === true) {
        throw new ModerationHttpError(403, "account deleted");
    }
    let imageDataUrl = null;
    let imageUnavailable = false;
    try {
        imageDataUrl = await loadImageDataUrl(store, {
            storagePath: input.storagePath,
            photoUrl: input.storagePath ? null : input.photoUrl,
        });
    } catch (error) {
        if (!isModerationOutage(error)) throw error;
        imageUnavailable = true;
    }
    const decision = await moderate({
        text: profileTextForModeration(input),
        imageDataUrl,
    });
    if (imageUnavailable && decision.status === "approved") {
        decision.status = "pending";
    }
    await writeProfileDecision({
        store,
        uid,
        existing,
        input,
        displayName,
        decision,
        serverTimestamp,
    });
    return { status: decision.status };
}

async function writeProfileDecision({
    store,
    uid,
    existing,
    input,
    displayName,
    decision,
    serverTimestamp,
}) {
    if (decision.status === "rejected") {
        if (decision.sexualMinors && input.storagePath) {
            await store.deleteStorageImage(input.storagePath);
        }
        await store.addReview(uid, profileReviewDocument({
            uid,
            decision,
            proposed: input,
            serverTimestamp,
        }));
        throw new ModerationHttpError(422, CONTENT_REJECTED);
    }
    const previous = existing.moderation?.status === "pending" && existing.moderation?.pending?.previous
        ? existing.moderation.pending.previous
        : profileSnapshot(existing);
    const patch = profileFieldPatch({ existing, input, displayName });
    patch.moderation = moderationStamp({
        status: decision.status,
        model: decision.model,
        storagePath: input.storagePath,
        serverTimestamp,
        pending: decision.status === "pending"
            ? {
                username: input.username,
                about: input.hasAbout ? input.about : null,
                photoUrl: input.photoUrl,
                storagePath: input.storagePath,
                previous,
            }
            : null,
    });
    await store.mergeUser(uid, patch);
}

function profileFieldPatch({ existing, input, displayName }) {
    const patch = {};
    const nextUsername = input.username ?? existing.username ?? null;
    if (input.username != null) {
        patch.username = input.username;
        patch.usernameLower = input.username.toLowerCase();
    }
    if (input.hasAbout) {
        patch.about = input.about;
    }
    if (input.photoUrl) {
        patch.photoUrl = input.photoUrl;
    }
    const authDisplayName = typeof displayName === "string" ? displayName.trim() : "";
    if (authDisplayName) {
        patch.displayNameLower = authDisplayName.toLowerCase();
    }
    if (nextUsername) {
        patch.searchWordPrefixes = buildUserSearchPrefixes({
            username: nextUsername,
            displayName: authDisplayName || existing.displayName || null,
        });
    }
    return patch;
}

export async function retryPendingCheckIn({ store, moderate, uid, checkInId, data, serverTimestamp }) {
    const moderation = data?.moderation || {};
    const attempts = Number(moderation.attempts) || 1;
    if (attempts >= MAX_MODERATION_ATTEMPTS) return { status: "skipped" };
    const storagePath = moderation.storagePath || null;
    let imageDataUrl = null;
    if (storagePath) {
        try {
            imageDataUrl = await store.loadStorageImage(storagePath);
        } catch (error) {
            if (!isModerationOutage(error)) throw error;
            await store.setCheckIn(uid, checkInId, {
                ...data,
                moderation: { ...moderation, attempts: attempts + 1 },
            });
            return { status: "pending" };
        }
    }
    const decision = await moderate({
        text: typeof data.message === "string" ? data.message : "",
        imageDataUrl,
    });
    if (decision.status === "pending") {
        await store.setCheckIn(uid, checkInId, {
            ...data,
            moderation: {
                ...moderation,
                attempts: attempts + 1,
                model: decision.model,
                checkedAt: serverTimestamp,
            },
        });
        return { status: "pending" };
    }
    if (decision.status === "rejected") {
        if (decision.sexualMinors && storagePath) {
            await store.deleteStorageImage(storagePath);
        }
        await store.addReview(uid, checkInReviewDocument({
            uid,
            decision,
            checkIn: {
                message: data.message,
                locationName: data.locationName,
                imageUrl: decision.sexualMinors ? null : data.imageUrl,
                storagePath: decision.sexualMinors ? null : storagePath,
            },
            serverTimestamp,
        }));
        await store.deleteCheckIn(uid, checkInId);
        return { status: "rejected" };
    }
    await store.setCheckIn(uid, checkInId, {
        ...data,
        moderation: moderationStamp({
            status: "approved",
            model: decision.model,
            storagePath,
            attempts,
            serverTimestamp,
        }),
    });
    return { status: "approved" };
}

export async function retryPendingProfile({ store, moderate, uid, data, serverTimestamp }) {
    const moderation = data?.moderation || {};
    const attempts = Number(moderation.attempts) || 1;
    if (moderation.status !== "pending") return { status: "skipped" };
    if (attempts >= MAX_MODERATION_ATTEMPTS) return { status: "skipped" };
    const pending = moderation.pending || {};
    const storagePath = pending.storagePath || moderation.storagePath || null;
    let imageDataUrl = null;
    try {
        imageDataUrl = await loadImageDataUrl(store, {
            storagePath,
            photoUrl: storagePath ? null : pending.photoUrl,
        });
    } catch (error) {
        if (!isModerationOutage(error)) throw error;
        await store.mergeUser(uid, {
            moderation: { ...moderation, attempts: attempts + 1 },
        });
        return { status: "pending" };
    }
    const decision = await moderate({
        text: profileTextForModeration({
            username: pending.username,
            about: pending.about,
            hasAbout: pending.about != null,
        }),
        imageDataUrl,
    });
    if (decision.status === "pending") {
        await store.mergeUser(uid, {
            moderation: {
                ...moderation,
                attempts: attempts + 1,
                model: decision.model,
                checkedAt: serverTimestamp,
            },
        });
        return { status: "pending" };
    }
    if (decision.status === "rejected") {
        if (decision.sexualMinors && storagePath) {
            await store.deleteStorageImage(storagePath);
        }
        await store.addReview(uid, profileReviewDocument({
            uid,
            decision,
            proposed: {
                username: pending.username,
                about: pending.about,
                photoUrl: decision.sexualMinors ? null : pending.photoUrl,
                storagePath: decision.sexualMinors ? null : storagePath,
            },
            serverTimestamp,
        }));
        await store.mergeUser(uid, {
            ...restoreProfileFields(pending.previous),
            moderation: moderationStamp({
                status: "approved",
                model: decision.model,
                attempts,
                serverTimestamp,
            }),
        });
        return { status: "rejected" };
    }
    await store.mergeUser(uid, {
        moderation: moderationStamp({
            status: "approved",
            model: decision.model,
            attempts,
            serverTimestamp,
        }),
    });
    return { status: "approved" };
}

export const imageDataUrlFromBuffer = (contentType, buffer) => {
    const mime = (contentType || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_CONTENT_TYPES.has(mime)) {
        throw new ModerationHttpError(400, "unsupported image");
    }
    if (!buffer || buffer.length === 0) {
        throw new ModerationHttpError(400, "unsupported image");
    }
    if (buffer.length > 10 * 1024 * 1024) {
        throw new ModerationHttpError(400, "image too large");
    }
    return `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`;
};
