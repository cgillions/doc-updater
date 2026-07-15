import { connectGithubTools } from "@github-tools/sdk/connect/eve";

export default connectGithubTools("github/docia-gh", {
    preset: ["repo-explorer"]
});
