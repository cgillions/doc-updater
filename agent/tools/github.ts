import { getToken } from "@vercel/connect";
import { createGithubTools } from "@github-tools/sdk/eve";

const token = await getToken("github/docia-gh", {
    subject: { type: "app" },
});

export default createGithubTools({
    token,
    preset: ["repo-explorer"]
});
