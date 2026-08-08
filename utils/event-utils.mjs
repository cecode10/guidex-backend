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
