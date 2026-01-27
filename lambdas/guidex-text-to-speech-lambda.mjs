import { TextToSpeechClient } from '@google-cloud/text-to-speech';

const DEFAULT_LANGUAGE_CODE = "en-US";
const DEFAULT_VOICE_NAME = "en-US-Neural2-F";
const DEFAULT_SSML_GENDER = "FEMALE";
const DEFAULT_AUDIO_ENCODING = "MP3";

// 1. Parse your credentials from the AWS env var
const credentials = JSON.parse(process.env.GOOGLE_TTS_SERVICE_ACCOUNT_JSON);

// 2. Fix potential newline issues
credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');

// 3. Initialize the client ONCE (outside the handler for better performance)
const client = new TextToSpeechClient({
    credentials,
    projectId: credentials.project_id,
});

export const handler = async (event) => {
    const request = {
        input: { text: event.text },
        voice: {
            languageCode: DEFAULT_LANGUAGE_CODE,
            name: DEFAULT_VOICE_NAME,
            ssmlGender: DEFAULT_SSML_GENDER,
        },
        audioConfig: { audioEncoding: DEFAULT_AUDIO_ENCODING },
    };

    try {
        // The library handles auth/token refresh automatically behind the scenes
        const [response] = await client.synthesizeSpeech(request);
        const audioContent = response.audioContent;

        return {
            statusCode: 200,
            body: audioContent.toString('base64')
        };
    } catch (error) {
        console.error("TTS Synthesis Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message }),
        };
    }
};