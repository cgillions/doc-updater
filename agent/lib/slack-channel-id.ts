const SLACK_CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]+$/u;

export function requireSlackChannelId(
  channelId = process.env.SLACK_CHANNEL_ID,
): string {
  if (!channelId || !SLACK_CHANNEL_ID_PATTERN.test(channelId)) {
    throw new Error(
      "SLACK_CHANNEL_ID must be a canonical Slack channel ID beginning with C or G, not a channel name.",
    );
  }

  return channelId;
}
