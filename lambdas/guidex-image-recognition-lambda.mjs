import { analyzeImage } from "../open-ai-service.mjs";

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

const getAllowedUsers = () => {
    const input = process.env.PERMITTED_USERS;
    if (!input) {
        throw new Error("missing permitted users");
    }
    return input
        .split(",")
        .map((email) => email.trim())
        .filter(Boolean);
};

const assertAllowedUser = (user, allowedUsers) => {
    const userEmail = user?.trim();
    if (!userEmail) {
        throw new Error("user is required");
    }
    if (!allowedUsers.includes(userEmail)) {
        const error = new Error("not-allowed");
        error.statusCode = 403;
        throw error;
    }
};

const processImageRecognition = async (input) => {
    const imageBase64 = input.input?.trim();
    if (!imageBase64) {
        throw new Error("input is required");
    }

    const userPromptResponse = await analyzeImage(imageBase64, input.location);
    console.log("user_prompt_response = " + userPromptResponse);
    return {
        response: userPromptResponse,
    };
};

export const handler = async (event) => {
    const isHttpRequest = Boolean(
        event?.requestContext || event?.rawPath || event?.httpMethod || event?.headers
    );

    try {
        const input = parseRequestBody(event);
        const allowedUsers = getAllowedUsers();
        assertAllowedUser(input.user, allowedUsers);

        const result = await processImageRecognition(input);
        return isHttpRequest ? toHttpResponse(200, result) : result;
    } catch (error) {
        console.error(error?.message || error);
        const statusCode = error?.statusCode || 500;
        const errorBody = {
            error: error?.message || "image-recognition failed",
        };
        return isHttpRequest ? toHttpResponse(statusCode, errorBody) : errorBody;
    }
};
