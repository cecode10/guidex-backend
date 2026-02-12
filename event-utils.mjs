/**
 * Parses the request body from an API Gateway event.
 * Handles both plain JSON strings and base64-encoded bodies.
 *
 * @param {Object} event - API Gateway event object
 * @returns {Object} Parsed body as a JavaScript object
 * @throws {{ statusCode: number, message: string }} if the body is missing or invalid JSON
 */
export const parseRequestBody = (event) => {
    if (!event.body) {
        const error = new Error("Request body is missing");
        error.statusCode = 400;
        throw error;
    }
    let raw = event.body;
    try {
        console.log("body=", raw);
        return JSON.parse(raw);
    } catch {
        const error = new Error("Invalid JSON in request body");
        error.statusCode = 400;
        throw error;
    }
};

/**
 * Validates that the parsed body contains all mandatory fields.
 * Throws a 400 error if any required field is missing or blank.
 *
 * @param {Object} body - Parsed request body
 * @param {string[]} fields - List of required field names
 * @returns {Object} The same body, for convenient chaining
 * @throws {{ statusCode: number, message: string }} if a field is missing
 */
export const validateMandatoryFields = (body, fields) => {
    const missing = fields.filter((f) => {
        const value = body[f];
        return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
    });
    if (missing.length > 0) {
        const error = new Error(`Missing required field(s): ${missing.join(", ")}`);
        error.statusCode = 400;
        throw error;
    }
    return body;
};
