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
        title: "Confirm your Ramblex email",
        footerNotice:
            "This is a service email sent because a Ramblex account registration was initiated with this email address. It is not marketing communication.",
    });

    return {
        to: email,
        subject: "Confirm your Ramblex email",
        text,
        html,
    };
};
