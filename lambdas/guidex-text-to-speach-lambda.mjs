const GOOGLE_TTS_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";
const DEFAULT_LANGUAGE_CODE = "en-US";
const DEFAULT_VOICE_NAME = "en-US-Neural2-F";
const DEFAULT_SSML_GENDER = "FEMALE";
const DEFAULT_AUDIO_ENCODING = "MP3";

const parseRequestBody = (event) => {
    if (!event) {
        return {};
    }
    if (typeof event === "string") {
        return JSON.parse(event);
    }
    if (event.body) {
        if (typeof event.body === "string") {
            return JSON.parse(event.body);
        }
        return event.body;
    }
    return event;
};

const buildRequestPayload = (input) => {
    const text = input.text?.trim();
    if (!text) {
        throw new Error("text is required");
    }

    const languageCode = input.languageCode || DEFAULT_LANGUAGE_CODE;
    const voiceName = input.voiceName || DEFAULT_VOICE_NAME;
    const ssmlGender = input.ssmlGender || DEFAULT_SSML_GENDER;
    const audioEncoding = input.audioEncoding || DEFAULT_AUDIO_ENCODING;

    return {
        input: {
            text,
        },
        voice: {
            languageCode,
            name: voiceName,
            ssmlGender,
        },
        audioConfig: {
            audioEncoding,
        },
    };
};

const getGoogleTtsApiKey = () => {
    return (process.env.GOOGLE_TTS_API_KEY
    );
};

const toHttpResponse = (statusCode, body) => {
    return {
        statusCode,
        headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
        body: JSON.stringify(body),
    };
};

export const handler = async (event) => {
    const isHttpRequest = Boolean(
        event?.requestContext || event?.rawPath || event?.httpMethod || event?.headers
    );

    try {
        const apiKey = getGoogleTtsApiKey();
        if (!apiKey) {
            throw new Error("missing Google Text-to-Speech API key");
        }

        const input = parseRequestBody(event);
        const payload = buildRequestPayload(input);

        const response = await fetch(`${GOOGLE_TTS_ENDPOINT}?key=${apiKey}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        const responseBody = await response.json();
        if (!response.ok) {
            const message =
                responseBody?.error?.message ||
                `text-to-speech failed with status ${response.status}`;
            throw new Error(message);
        }

        const result = {
            audioContent: responseBody.audioContent,
            audioEncoding: payload.audioConfig.audioEncoding,
            languageCode: payload.voice.languageCode,
            voiceName: payload.voice.name,
        };

        return isHttpRequest ? toHttpResponse(200, result) : result;
    } catch (error) {
        console.error(error?.message || error);
        const errorBody = {
            error: error?.message || "text-to-speech failed",
        };
        return isHttpRequest ? toHttpResponse(500, errorBody) : errorBody;
    }
};
