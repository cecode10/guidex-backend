import { renderMailTemplate } from "./mail-template-utils.mjs";

/**
 * Content for {@link import("../services/mail-service.mjs").sendMail}.
 *
 * @param {{ email: string, uid: string }} input
 */
export const buildAccountDeletedMail = ({ email, uid }) => {
    const { html, text } = renderMailTemplate("account-deleted", {
        accountId: uid || "(unknown)",
        title: "Your Ramblex account was deleted",
        footerNotice:
            "This is a service email sent because a Ramblex account associated with this address was deleted. It is not marketing communication.",
    });

    return {
        to: email,
        bccSupport: true,
        subject: "Your Ramblex account was deleted",
        text,
        html,
    };
};
