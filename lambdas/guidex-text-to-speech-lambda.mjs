import { GoogleAuth } from "google-auth-library";

const GOOGLE_TTS_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";
const GOOGLE_TTS_SCOPE = "https://www.googleapis.com/auth/cloud-texttospeech";
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

import { promises as dns } from 'node:dns';
import https from 'node:https';

export const debugGoogleNetwork = async () => {
    try {
        // 1. Test DNS
        // Using resolve4 to specifically check IPv4, which is safer for VPCs
        const addresses = await dns.resolve4('oauth2.googleapis.com');
        console.log('✅ DNS resolved Google Auth to:', addresses);

        // 2. Test HTTPS Handshake
        const ping = await new Promise((resolve, reject) => {
            // Google's token endpoint will return 405 (Method Not Allowed) for a GET,
            // which is a GOOD sign—it means we reached the server.
            const req = https.get('https://oauth2.googleapis.com/token', (res) => {
                resolve(res.statusCode);
            });

            req.on('error', (err) => {
                reject(err);
            });

            req.setTimeout(5000, () => {
                req.destroy();
                reject(new Error("Timeout reaching Google - Check VPC/Firewall"));
            });
        });

        console.log('✅ Google Auth status code:', ping);

    } catch (err) {
        console.error('❌ Network Isolation Error:', err.message);
        // If this logs "getaddrinfo EAI_AGAIN", it's a DNS issue.
        // If this logs "ETIMEDOUT", it's a Routing/NAT issue.
    }
};

const getGoogleTtsAccessToken = async () => {

    await debugGoogleNetwork();
    const credentialsJson = process.env.GOOGLE_TTS_SERVICE_ACCOUNT_JSON;
    if (!credentialsJson) {
        throw new Error("missing Google service account credentials");
    }

    let credentials;
    try {
        credentials = JSON.parse(credentialsJson);
        // CRITICAL FIX: Ensure the private key has real newlines
        if (credentials.private_key) {
            credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
        }
    } catch (error) {
        throw new Error("invalid Google service account credentials JSON");
    }

    const auth = new GoogleAuth({
        credentials,
        scopes: [GOOGLE_TTS_SCOPE],
        projectId: credentials.project_id, // Explicitly set the project ID
        clientOptions: {
            timeout: 10000 // 10 seconds
        }
    });

    try {
        const client = await auth.getClient();
        const accessTokenResponse = await client.getAccessToken();

        if (!accessTokenResponse?.token) {
            throw new Error("failed to obtain Google access token");
        }
        return accessTokenResponse.token;
    } catch (err) {
        // Log the internal error to see if it's a permission issue or a clock sync issue
        console.error("Internal Auth Error:", err.message);
        throw err;
    }
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
        const accessToken = await getGoogleTtsAccessToken();

        const input = parseRequestBody(event);
        console.log("event.body:" + input);
        const payload = buildRequestPayload(input);

        const response = await fetch(GOOGLE_TTS_ENDPOINT, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${accessToken}`,
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
        console.log("successful processed text-to-speech");

        return isHttpRequest ? toHttpResponse(200, result) : result;
    } catch (error) {
        console.error(error?.message || error);
        const errorBody = {
            error: error?.message || "text-to-speech failed",
        };
        return isHttpRequest ? toHttpResponse(500, errorBody) : errorBody;
    }
};


