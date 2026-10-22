// https://docs.slack.dev/messaging/formatting-message-text/ — decode only Slack's three entities.
export function normalizeSlackText(
  text: string,
  names: Record<string, string>,
): string {
  return text
    .replace(
      /<@([A-Za-z0-9]+)>|<(https?:\/\/[^>|]+)(?:\|([^>]*))?>/g,
      (
        _match,
        user: string | undefined,
        url: string | undefined,
        label: string | undefined,
      ) =>
        user
          ? `@${names[user] ?? user}`
          : label
            ? `${label} (${url ?? ''})`
            : (url ?? ''),
    )
    .replace(/&amp;|&lt;|&gt;/g, (entity) =>
      entity === '&amp;' ? '&' : entity === '&lt;' ? '<' : '>',
    );
}
