import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";

export default eveChannel({
  auth: [
    // Authenticate deployed app-to-agent requests with Vercel OIDC.
    vercelOidc(),
    // Permit local development only; this authenticator rejects remote requests.
    localDev(),
  ],
});
