import { renderMailTemplate } from "./mail-template-utils.mjs";

/**
 * Content for {@link import("../services/mail-service.mjs").sendMail}.
 *
 * @param {{ email: string, verificationUrl: string }} input
 */
export const buildEmailVerificationMail = ({ email, verificationUrl }) => {
    const { html, text } = renderMailTemplate("email-verification", {
        email: email || "",
        verificationUrl: verificationUrl || "",
    });

    return {
        to: email,
        subject: "Confirm your Ramblex email",
        text,
        html,
    };
};
