import { loadConfluenceClientConfig } from "../config/confluence-client-config.ts";
import { ConfluencePageClient } from "./page-client.ts";

/** Creates the production read-only Confluence client from runtime secrets. */
export function createConfluencePageClient(): ConfluencePageClient {
  return new ConfluencePageClient(loadConfluenceClientConfig());
}
