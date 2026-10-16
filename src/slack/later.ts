import type { SlackApiClient } from "./client.ts";
import { renderSlackMessageContent } from "./render.ts";

/**
 * Slack's views of the pile since Later split into To-dos and Saved: the
 * Saved section of Home, the To-dos tab, and the completed and archived
 * states. `saved.list` accepts `filter` values none, saved, todo, completed
 * and archived; its own `saved` value means the whole in-progress pile with
 * to-dos sorted first, not the Saved section, so that view is the default
 * view narrowed to the items whose `todo_state` is `saved`. An item with no
 * `todo_state` predates the split, when everything was saved for later.
 */
export type LaterFilter = "saved" | "todo" | "completed" | "archived";

const VIEWS: Record<LaterFilter, { api: string; todoState?: string }> = {
  saved: { api: "none", todoState: "saved" },
  todo: { api: "todo" },
  completed: { api: "completed" },
  archived: { api: "archived" },
};

export type LaterItem = {
  /** `message` for a saved or to-do'd message; `reminder` for a to-do typed by hand */
  item_type: string;
  channel_id: string;
  channel_name?: string;
  ts: string;
  /** Slack's id for a hand-typed to-do; messages are keyed by channel_id + ts instead */
  item_id?: string;
  state: string;
  /** Which pile Slack shows the item in: `saved`, `to_do` or `completed` */
  todo_state?: string;
  date_saved: number;
  date_completed?: number;
  date_due?: number;
  /** A hand-typed to-do's own text */
  description?: string;
  message?: {
    author?: { user_id?: string; bot_id?: string };
    content?: string;
    thread_ts?: string;
    reply_count?: number;
  };
};

export async function fetchLaterItems(
  client: SlackApiClient,
  options?: {
    state?: "in_progress" | "archived" | "completed" | "all";
    /** One of Slack's views; omitted, Slack answers with its default view */
    filter?: LaterFilter;
    limit?: number;
    maxBodyChars?: number;
    countsOnly?: boolean;
    cursor?: string;
    dueBefore?: number;
  },
): Promise<{
  counts: {
    /** Everything not completed or archived: the Saved pile and the To-dos together */
    in_progress: number;
    /** The Saved section of Home */
    saved: number;
    /** The To-dos tab */
    todo: number;
    /** To-dos whose reminder has passed */
    overdue: number;
    archived: number;
    completed: number;
    total: number;
  };
  items: LaterItem[];
  next_cursor?: string;
}> {
  const stateFilter = options?.state ?? "in_progress";
  const limit = options?.limit ?? 20;
  const maxBodyChars = options?.maxBodyChars ?? 4000;
  const countsOnly = options?.countsOnly ?? false;
  const dueBefore = options?.dueBefore;
  const view = options?.filter === undefined ? undefined : VIEWS[options.filter];
  const apiFilter = view?.api;
  const matches = (item: Record<string, unknown>): boolean => {
    const itemType = getString(item.item_type);
    if (itemType !== "message" && itemType !== "reminder") {
      return false;
    }
    if (view?.todoState !== undefined && (getString(item.todo_state) ?? "saved") !== view.todoState) {
      return false;
    }
    if (stateFilter !== "all" && getString(item.state) !== stateFilter) {
      return false;
    }
    if (dueBefore === undefined) {
      return true;
    }
    const dateDue = getNumber(item.date_due) ?? 0;
    return dateDue > 0 && dateDue <= dueBefore;
  };

  let currentCursor = options?.cursor;
  let allRawItems: Record<string, unknown>[] = [];
  let counts: Record<string, unknown> = {};
  let nextCursor: string | undefined;

  while (true) {
    const resp = await client.api("saved.list", {
      limit: 50,
      cursor: currentCursor,
      ...(apiFilter === undefined ? {} : { filter: apiFilter }),
    });

    if (!currentCursor) {
      counts = isRecord(resp.counts) ? resp.counts : {};
    }

    const pageRawItems = asArray(resp.saved_items).filter(isRecord);
    allRawItems.push(...pageRawItems);

    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    nextCursor = meta ? getString(meta.next_cursor) : undefined;

    if (countsOnly) {
      break;
    }

    if (allRawItems.filter(matches).length >= limit || !nextCursor) {
      break;
    }
    currentCursor = nextCursor;
  }

  // Since the split, uncompleted_count is the Saved pile alone and the To-dos have their own count.
  const saved = getNumber(counts.uncompleted_count) ?? 0;
  const todo = getNumber(counts.todo_count) ?? 0;
  const result = {
    counts: {
      in_progress: saved + todo,
      saved,
      todo,
      overdue: getNumber(counts.uncompleted_overdue_count) ?? 0,
      archived: getNumber(counts.archived_count) ?? 0,
      completed: getNumber(counts.completed_count) ?? 0,
      total: getNumber(counts.total_count) ?? 0,
    },
    items: [] as LaterItem[],
    next_cursor: nextCursor,
  };

  if (countsOnly) {
    return result;
  }

  const filtered = allRawItems.filter(matches).slice(0, limit);

  // Hydrate items in parallel
  result.items = await Promise.all(
    filtered.map(async (item) => {
      const itemType = getString(item.item_type) ?? "message";
      const state = getString(item.state) ?? "in_progress";
      const todoState = getString(item.todo_state);
      const dateSaved = getNumber(item.date_created) ?? 0;
      const dateCompleted = getNumber(item.date_completed);
      const dateDue = getNumber(item.date_due);
      const stamps = {
        state,
        todo_state: todoState,
        date_saved: dateSaved,
        date_completed: dateCompleted && dateCompleted > 0 ? dateCompleted : undefined,
        date_due: dateDue && dateDue > 0 ? dateDue : undefined,
      };

      // A to-do typed by hand has no conversation behind it, only its own text.
      if (itemType === "reminder") {
        return {
          item_type: "reminder",
          channel_id: "",
          ts: "",
          item_id: getString(item.item_id),
          ...stamps,
          description: clip(renderReminderDescription(item.description), maxBodyChars) || undefined,
        } satisfies LaterItem;
      }

      const channelId = getString(item.item_id) ?? "";
      const ts = getString(item.ts) ?? "";

      let channelName: string | undefined;
      let message: LaterItem["message"];

      // Resolve channel name
      try {
        const info = await client.api("conversations.info", {
          channel: channelId,
        });
        const ch = isRecord(info.channel) ? info.channel : null;
        if (ch) {
          channelName = getString(ch.name) ?? getString(ch.name_normalized) ?? undefined;

          // For DMs, resolve user display name
          if (ch.is_im && !channelName) {
            const userId = getString(ch.user);
            if (userId) {
              try {
                const userInfo = await client.api("users.info", { user: userId });
                const u = isRecord(userInfo.user) ? userInfo.user : null;
                const profile = u && isRecord(u.profile) ? u.profile : null;
                channelName =
                  getString(profile?.display_name) ||
                  getString(u?.real_name) ||
                  getString(u?.name) ||
                  undefined;
              } catch {
                // ignore
              }
            }
          }
        }
      } catch {
        // ignore
      }

      // Fetch the actual message
      if (ts) {
        try {
          const history = await client.api("conversations.history", {
            channel: channelId,
            latest: ts,
            inclusive: true,
            limit: 1,
          });
          const msgs = asArray(history.messages).filter(isRecord);
          const msg = msgs.find((m) => getString(m.ts) === ts);
          if (msg) {
            const content = clip(renderSlackMessageContent(msg), maxBodyChars);

            message = {
              author:
                getString(msg.user) || getString(msg.bot_id)
                  ? {
                      user_id: getString(msg.user) ?? undefined,
                      bot_id: getString(msg.bot_id) ?? undefined,
                    }
                  : undefined,
              content: content || undefined,
              thread_ts: getString(msg.thread_ts) ?? undefined,
              reply_count: getNumber(msg.reply_count) ?? undefined,
            };
          }
        } catch {
          // ignore — message may have been deleted
        }
      }

      return {
        item_type: "message",
        channel_id: channelId,
        channel_name: channelName,
        ts,
        ...stamps,
        message,
      } satisfies LaterItem;
    }),
  );

  return result;
}

/**
 * Mark a saved item as completed, archived, or reopen it.
 * Uses multipart/form-data with the `mark` param (not `state`).
 * Valid `mark` values: completed, uncompleted, archived, unarchived.
 */
export async function updateLaterMark(
  client: SlackApiClient,
  input: {
    channelId: string;
    ts: string;
    mark: "completed" | "uncompleted" | "archived" | "unarchived";
  },
): Promise<void> {
  await client.apiMultipart("saved.update", {
    item_id: input.channelId,
    item_type: "message",
    ts: input.ts,
    mark: input.mark,
  });
}

export async function saveLater(
  client: SlackApiClient,
  input: { channelId: string; ts: string },
): Promise<void> {
  await client.api("saved.add", {
    item_id: input.channelId,
    item_type: "message",
    ts: input.ts,
  });
}

export async function removeLater(
  client: SlackApiClient,
  input: { channelId: string; ts: string },
): Promise<void> {
  await client.api("saved.delete", {
    item_id: input.channelId,
    item_type: "message",
    ts: input.ts,
  });
}

export async function setLaterReminder(
  client: SlackApiClient,
  input: { channelId: string; ts: string; dateDue: number },
): Promise<void> {
  await client.apiMultipart("saved.update", {
    item_id: input.channelId,
    item_type: "message",
    ts: input.ts,
    date_due: String(input.dateDue),
  });
}

export function parseReminderDuration(input: string): number {
  const now = Math.floor(Date.now() / 1000);
  const trimmed = input.trim().toLowerCase();

  // Relative durations: 30m, 1h, 3h, 2d, 1.5h
  const relMatch = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/,
  );
  if (relMatch) {
    const amount = Number.parseFloat(relMatch[1]!);
    const unit = relMatch[2]!.charAt(0);
    if (unit === "m") {
      return now + amount * 60;
    }
    if (unit === "h") {
      return now + amount * 3600;
    }
    if (unit === "d") {
      return now + amount * 86400;
    }
  }

  // Named times
  const tomorrow9am = getNext9am(1);
  if (trimmed === "tomorrow") {
    return tomorrow9am;
  }

  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayIndex = dayNames.indexOf(trimmed);
  if (dayIndex >= 0) {
    const today = new Date();
    const currentDay = today.getDay();
    let daysUntil = dayIndex - currentDay;
    if (daysUntil <= 0) {
      daysUntil += 7;
    }
    return getNext9am(daysUntil);
  }

  // Unix timestamp passthrough
  const asNum = Number(trimmed);
  if (!Number.isNaN(asNum) && asNum > 1000000000) {
    return asNum;
  }

  throw new Error(
    `Invalid duration: "${input}". Use: 30m, 1h, 3h, 2d, tomorrow, monday, or a unix timestamp.`,
  );
}

function getNext9am(daysFromNow: number): number {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(9, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

/** Cut rendered text to the body limit; -1 means unlimited. */
function clip(text: string, maxBodyChars: number): string {
  return maxBodyChars >= 0 && text.length > maxBodyChars ? `${text.slice(0, maxBodyChars)}\n…` : text;
}

/**
 * A hand-typed to-do's text. Slack stores it as rich_text blocks, sometimes
 * serialized as a JSON string; plain text is passed through.
 */
export function renderReminderDescription(raw: unknown): string {
  let blocks: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("[")) {
      return trimmed;
    }
    try {
      blocks = JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return Array.isArray(blocks) ? renderSlackMessageContent({ blocks }) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
