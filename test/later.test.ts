import { describe, expect, test } from "bun:test";
import {
  fetchLaterItems,
  renderReminderDescription,
  updateLaterMark,
  saveLater,
  removeLater,
  setLaterReminder,
  parseReminderDuration,
} from "../src/slack/later.ts";
import type { SlackApiClient } from "../src/slack/client.ts";
import { parseFilter } from "../src/cli/later-command.ts";

function createClient(responses: Record<string, Record<string, unknown>>) {
  const calls: { method: string; params: Record<string, unknown>; multipart?: boolean }[] = [];
  const client = {
    api: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return responses[method] ?? { ok: true };
    },
    apiMultipart: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params, multipart: true });
      return responses[method] ?? { ok: true };
    },
  } as unknown as SlackApiClient;
  return { client, calls };
}

describe("fetchLaterItems", () => {
  test("returns counts only when countsOnly is true", async () => {
    const { client, calls } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [
          {
            item_id: "C123",
            item_type: "message",
            ts: "1.1",
            state: "in_progress",
            date_created: 100,
          },
        ],
        counts: {
          uncompleted_count: 5,
          archived_count: 1,
          completed_count: 10,
          total_count: 16,
        },
      },
    });

    const result = await fetchLaterItems(client, { countsOnly: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("saved.list");
    expect(result.counts).toEqual({
      in_progress: 5,
      saved: 5,
      todo: 0,
      overdue: 0,
      archived: 1,
      completed: 10,
      total: 16,
    });
    expect(result.items).toHaveLength(0);
  });

  test("keeps messages and hand-typed to-dos, drops other item types", async () => {
    const { client } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [
          {
            item_id: "Sa123",
            item_type: "reminder",
            ts: "",
            state: "in_progress",
            date_created: 100,
          },
          {
            item_id: "C123",
            item_type: "message",
            ts: "1.1",
            state: "in_progress",
            date_created: 200,
          },
          {
            item_id: "F123",
            item_type: "file",
            state: "in_progress",
            date_created: 300,
          },
        ],
        counts: { uncompleted_count: 3, archived_count: 0, completed_count: 0, total_count: 3 },
      },
      "conversations.info": { ok: true, channel: { name: "general" } },
      "conversations.history": {
        ok: true,
        messages: [{ ts: "1.1", text: "hello", user: "U1" }],
      },
    });

    const result = await fetchLaterItems(client);

    expect(result.items.map((item) => [item.item_type, item.item_id ?? item.channel_id])).toEqual([
      ["reminder", "Sa123"],
      ["message", "C123"],
    ]);
  });

  test("filters by state", async () => {
    const { client } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [
          {
            item_id: "C1",
            item_type: "message",
            ts: "1.1",
            state: "in_progress",
            date_created: 100,
          },
          {
            item_id: "C2",
            item_type: "message",
            ts: "2.2",
            state: "completed",
            date_created: 200,
            date_completed: 300,
          },
          { item_id: "C3", item_type: "message", ts: "3.3", state: "archived", date_created: 150 },
        ],
        counts: { uncompleted_count: 1, archived_count: 1, completed_count: 1, total_count: 3 },
      },
      "conversations.info": { ok: true, channel: { name: "test" } },
      "conversations.history": { ok: true, messages: [{ ts: "2.2", text: "done", user: "U1" }] },
    });

    const result = await fetchLaterItems(client, { state: "completed" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.state).toBe("completed");
    expect(result.items[0]?.date_completed).toBe(300);
  });

  test("state 'all' returns all items", async () => {
    const { client } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [
          {
            item_id: "C1",
            item_type: "message",
            ts: "1.1",
            state: "in_progress",
            date_created: 100,
          },
          { item_id: "C2", item_type: "message", ts: "2.2", state: "completed", date_created: 200 },
        ],
        counts: { uncompleted_count: 1, archived_count: 0, completed_count: 1, total_count: 2 },
      },
      "conversations.info": { ok: true, channel: { name: "test" } },
      "conversations.history": { ok: true, messages: [] },
    });

    const result = await fetchLaterItems(client, { state: "all" });

    expect(result.items).toHaveLength(2);
  });

  test("respects limit", async () => {
    const { client } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [
          {
            item_id: "C1",
            item_type: "message",
            ts: "1.1",
            state: "in_progress",
            date_created: 100,
          },
          {
            item_id: "C2",
            item_type: "message",
            ts: "2.2",
            state: "in_progress",
            date_created: 200,
          },
          {
            item_id: "C3",
            item_type: "message",
            ts: "3.3",
            state: "in_progress",
            date_created: 300,
          },
        ],
        counts: { uncompleted_count: 3, archived_count: 0, completed_count: 0, total_count: 3 },
      },
      "conversations.info": { ok: true, channel: { name: "test" } },
      "conversations.history": { ok: true, messages: [] },
    });

    const result = await fetchLaterItems(client, { limit: 2 });

    expect(result.items).toHaveLength(2);
  });

  test("hydrates message content", async () => {
    const { client } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [
          {
            item_id: "C123",
            item_type: "message",
            ts: "1.1",
            state: "in_progress",
            date_created: 100,
          },
        ],
        counts: { uncompleted_count: 1, archived_count: 0, completed_count: 0, total_count: 1 },
      },
      "conversations.info": { ok: true, channel: { name: "general", is_channel: true } },
      "conversations.history": {
        ok: true,
        messages: [
          {
            ts: "1.1",
            text: "Hello world",
            user: "U456",
            thread_ts: "1.0",
            reply_count: 3,
          },
        ],
      },
    });

    const result = await fetchLaterItems(client);

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.channel_id).toBe("C123");
    expect(item.channel_name).toBe("general");
    expect(item.message?.author?.user_id).toBe("U456");
    expect(item.message?.content).toBe("Hello world");
    expect(item.message?.thread_ts).toBe("1.0");
    expect(item.message?.reply_count).toBe(3);
  });

  test("resolves DM user display names", async () => {
    const { client } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [
          {
            item_id: "D123",
            item_type: "message",
            ts: "1.1",
            state: "in_progress",
            date_created: 100,
          },
        ],
        counts: { uncompleted_count: 1, archived_count: 0, completed_count: 0, total_count: 1 },
      },
      "conversations.info": { ok: true, channel: { is_im: true, user: "U789" } },
      "conversations.history": { ok: true, messages: [{ ts: "1.1", text: "hi", user: "U789" }] },
      "users.info": {
        ok: true,
        user: { id: "U789", real_name: "Alice Smith", profile: { display_name: "alice" } },
      },
    });

    const result = await fetchLaterItems(client);

    expect(result.items[0]?.channel_name).toBe("alice");
  });

  test("truncates long message content", async () => {
    const longText = "x".repeat(5000);
    const { client } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [
          {
            item_id: "C1",
            item_type: "message",
            ts: "1.1",
            state: "in_progress",
            date_created: 100,
          },
        ],
        counts: { uncompleted_count: 1, archived_count: 0, completed_count: 0, total_count: 1 },
      },
      "conversations.info": { ok: true, channel: { name: "test" } },
      "conversations.history": { ok: true, messages: [{ ts: "1.1", text: longText, user: "U1" }] },
    });

    const result = await fetchLaterItems(client, { maxBodyChars: 100 });

    expect(result.items[0]?.message?.content?.length).toBeLessThanOrEqual(103); // 100 + "\n…"
  });

  test("returns date_due only for items with a reminder", async () => {
    const { client } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [
          {
            item_id: "C1",
            item_type: "message",
            ts: "1.1",
            state: "in_progress",
            date_created: 100,
            date_due: 500,
          },
          {
            item_id: "C2",
            item_type: "message",
            ts: "2.2",
            state: "in_progress",
            date_created: 200,
            date_due: 0,
          },
        ],
        counts: { uncompleted_count: 2, archived_count: 0, completed_count: 0, total_count: 2 },
      },
      "conversations.info": { ok: true, channel: { name: "test" } },
      "conversations.history": { ok: true, messages: [] },
    });

    const result = await fetchLaterItems(client);

    expect(result.items.map((item) => item.date_due)).toEqual([500, undefined]);
  });

  test("dueBefore keeps overdue and due-by items, drops later and unscheduled ones", async () => {
    const { client } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [
          { item_id: "C1", item_type: "message", ts: "1.1", state: "in_progress", date_due: 100 },
          { item_id: "C2", item_type: "message", ts: "2.2", state: "in_progress", date_due: 1000 },
          { item_id: "C3", item_type: "message", ts: "3.3", state: "in_progress", date_due: 1001 },
          { item_id: "C4", item_type: "message", ts: "4.4", state: "in_progress", date_due: 0 },
          { item_id: "C5", item_type: "message", ts: "5.5", state: "in_progress" },
        ],
        counts: { uncompleted_count: 5, archived_count: 0, completed_count: 0, total_count: 5 },
      },
      "conversations.info": { ok: true, channel: { name: "test" } },
      "conversations.history": { ok: true, messages: [] },
    });

    const result = await fetchLaterItems(client, { dueBefore: 1000 });

    expect(result.items.map((item) => item.channel_id)).toEqual(["C1", "C2"]);
  });

  test("dueBefore applies before limit and keeps paging for matches", async () => {
    const calls: Record<string, unknown>[] = [];
    const pages = [
      {
        ok: true,
        saved_items: [
          { item_id: "C1", item_type: "message", ts: "1.1", state: "in_progress", date_due: 9999 },
        ],
        counts: { uncompleted_count: 2, archived_count: 0, completed_count: 0, total_count: 2 },
        response_metadata: { next_cursor: "page2" },
      },
      {
        ok: true,
        saved_items: [
          { item_id: "C2", item_type: "message", ts: "2.2", state: "in_progress", date_due: 100 },
        ],
      },
    ];
    const client = {
      api: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === "saved.list") {
          calls.push(params);
          return pages[calls.length - 1] ?? { ok: true };
        }
        return { ok: true };
      },
    } as unknown as SlackApiClient;

    const result = await fetchLaterItems(client, { dueBefore: 1000, limit: 1 });

    expect(calls.map((params) => params.cursor)).toEqual([undefined, "page2"]);
    expect(result.items.map((item) => item.channel_id)).toEqual(["C2"]);
  });
});

describe("updateLaterMark", () => {
  test("sends mark=completed via multipart", async () => {
    const { client, calls } = createClient({});

    await updateLaterMark(client, { channelId: "C123", ts: "1.1", mark: "completed" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("saved.update");
    expect(calls[0]?.multipart).toBe(true);
    expect(calls[0]?.params).toEqual({
      item_id: "C123",
      item_type: "message",
      ts: "1.1",
      mark: "completed",
    });
  });

  test("sends mark=archived via multipart", async () => {
    const { client, calls } = createClient({});

    await updateLaterMark(client, { channelId: "C123", ts: "1.1", mark: "archived" });

    expect(calls[0]?.params.mark).toBe("archived");
    expect(calls[0]?.multipart).toBe(true);
  });

  test("sends mark=uncompleted via multipart", async () => {
    const { client, calls } = createClient({});

    await updateLaterMark(client, { channelId: "C123", ts: "1.1", mark: "uncompleted" });

    expect(calls[0]?.params.mark).toBe("uncompleted");
  });

  test("sends mark=unarchived via multipart", async () => {
    const { client, calls } = createClient({});

    await updateLaterMark(client, { channelId: "C123", ts: "1.1", mark: "unarchived" });

    expect(calls[0]?.params.mark).toBe("unarchived");
  });
});

describe("saveLater", () => {
  test("calls saved.add with correct params", async () => {
    const { client, calls } = createClient({});

    await saveLater(client, { channelId: "C123", ts: "1.1" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("saved.add");
    expect(calls[0]?.params).toEqual({
      item_id: "C123",
      item_type: "message",
      ts: "1.1",
    });
  });
});

describe("removeLater", () => {
  test("calls saved.delete with correct params", async () => {
    const { client, calls } = createClient({});

    await removeLater(client, { channelId: "C123", ts: "1.1" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("saved.delete");
    expect(calls[0]?.params).toEqual({
      item_id: "C123",
      item_type: "message",
      ts: "1.1",
    });
  });
});

describe("setLaterReminder", () => {
  test("calls saved.update via multipart with date_due", async () => {
    const { client, calls } = createClient({});

    await setLaterReminder(client, { channelId: "C123", ts: "1.1", dateDue: 1700000000 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("saved.update");
    expect(calls[0]?.multipart).toBe(true);
    expect(calls[0]?.params).toEqual({
      item_id: "C123",
      item_type: "message",
      ts: "1.1",
      date_due: "1700000000",
    });
  });
});

describe("parseReminderDuration", () => {
  test("parses minutes", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = parseReminderDuration("30m");
    expect(result).toBeGreaterThanOrEqual(now + 30 * 60 - 2);
    expect(result).toBeLessThanOrEqual(now + 30 * 60 + 2);
  });

  test("parses hours", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = parseReminderDuration("2h");
    expect(result).toBeGreaterThanOrEqual(now + 2 * 3600 - 2);
    expect(result).toBeLessThanOrEqual(now + 2 * 3600 + 2);
  });

  test("parses fractional hours", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = parseReminderDuration("1.5h");
    expect(result).toBeGreaterThanOrEqual(now + 1.5 * 3600 - 2);
    expect(result).toBeLessThanOrEqual(now + 1.5 * 3600 + 2);
  });

  test("parses days", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = parseReminderDuration("3d");
    expect(result).toBeGreaterThanOrEqual(now + 3 * 86400 - 2);
    expect(result).toBeLessThanOrEqual(now + 3 * 86400 + 2);
  });

  test("parses 'tomorrow' as next day 9 AM", () => {
    const result = parseReminderDuration("tomorrow");
    const date = new Date(result * 1000);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(0);

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(date.getDate()).toBe(tomorrow.getDate());
  });

  test("parses day names", () => {
    const result = parseReminderDuration("monday");
    const date = new Date(result * 1000);
    expect(date.getHours()).toBe(9);
    expect(date.getDay()).toBe(1); // Monday
  });

  test("passes through unix timestamps", () => {
    const result = parseReminderDuration("1700000000");
    expect(result).toBe(1700000000);
  });

  test("supports verbose unit names", () => {
    const now = Math.floor(Date.now() / 1000);

    const mins = parseReminderDuration("5 minutes");
    expect(mins).toBeGreaterThanOrEqual(now + 5 * 60 - 2);

    const hrs = parseReminderDuration("1 hour");
    expect(hrs).toBeGreaterThanOrEqual(now + 3600 - 2);

    const days = parseReminderDuration("2 days");
    expect(days).toBeGreaterThanOrEqual(now + 2 * 86400 - 2);
  });

  test("throws on invalid input", () => {
    expect(() => parseReminderDuration("banana")).toThrow("Invalid duration");
    expect(() => parseReminderDuration("")).toThrow("Invalid duration");
    expect(() => parseReminderDuration("abc123")).toThrow("Invalid duration");
  });
});

describe("fetchLaterItems views and to-dos", () => {
  const counts = { uncompleted_count: 1, archived_count: 0, completed_count: 0, total_count: 1 };
  const message = {
    item_id: "C1",
    item_type: "message",
    ts: "1.1",
    state: "in_progress",
    todo_state: "to_do",
    date_created: 100,
    date_due: 500,
  };

  test("asks Slack for one of its views and surfaces todo_state", async () => {
    const { client, calls } = createClient({
      "saved.list": { ok: true, saved_items: [message], counts },
      "conversations.info": { ok: true, channel: { name: "atlas" } },
      "conversations.history": { ok: true, messages: [] },
    });

    const result = await fetchLaterItems(client, { filter: "todo" });

    expect(calls[0]?.params.filter).toBe("todo");
    expect(result.items[0]?.item_type).toBe("message");
    expect(result.items[0]?.todo_state).toBe("to_do");
    expect(result.items[0]?.date_due).toBe(500);
  });

  test("sends no filter by default", async () => {
    const plain = createClient({ "saved.list": { ok: true, saved_items: [], counts } });
    await fetchLaterItems(plain.client);
    expect("filter" in (plain.calls[0]?.params ?? {})).toBe(false);
  });

  test("the Saved section is the default view narrowed to todo_state saved", async () => {
    const { client, calls } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [
          message,
          { ...message, item_id: "C2", ts: "2.2", todo_state: "saved", date_due: 0 },
          { item_id: "C3", item_type: "message", ts: "3.3", state: "in_progress", date_created: 300 },
        ],
        counts,
      },
      "conversations.info": { ok: true, channel: { name: "atlas" } },
      "conversations.history": { ok: true, messages: [] },
    });

    const result = await fetchLaterItems(client, { filter: "saved" });

    expect(calls[0]?.params.filter).toBe("none");
    expect(result.items.map((item) => item.channel_id)).toEqual(["C2", "C3"]);
  });

  test("splits the counts into the Saved pile and the To-dos when Slack reports both", async () => {
    const { client } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [],
        counts: {
          uncompleted_count: 69,
          uncompleted_overdue_count: 2,
          todo_count: 93,
          archived_count: 0,
          completed_count: 3691,
          total_count: 3853,
        },
      },
    });
    const result = await fetchLaterItems(client, { countsOnly: true });
    expect(result.counts).toEqual({
      in_progress: 162,
      saved: 69,
      todo: 93,
      overdue: 2,
      archived: 0,
      completed: 3691,
      total: 3853,
    });
  });

  test("renders a hand-typed to-do from its own text without fetching a conversation", async () => {
    const { client, calls } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [
          {
            item_id: "Rm1",
            item_type: "reminder",
            state: "in_progress",
            todo_state: "to_do",
            date_created: 100,
            date_due: 900,
            description: [
              {
                type: "rich_text",
                elements: [
                  { type: "rich_text_section", elements: [{ type: "text", text: "Send the board deck" }] },
                ],
              },
            ],
          },
        ],
        counts,
      },
    });

    const result = await fetchLaterItems(client, { filter: "todo" });

    expect(calls.map((c) => c.method)).toEqual(["saved.list"]);
    expect(result.items).toEqual([
      {
        item_type: "reminder",
        channel_id: "",
        ts: "",
        item_id: "Rm1",
        state: "in_progress",
        todo_state: "to_do",
        date_saved: 100,
        date_completed: undefined,
        date_due: 900,
        description: "Send the board deck",
      },
    ]);
  });

  test("still leaves file items out", async () => {
    const { client } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [{ item_id: "F1", item_type: "file", state: "in_progress", date_created: 1 }],
        counts,
      },
    });
    const result = await fetchLaterItems(client, { state: "all" });
    expect(result.items).toHaveLength(0);
  });
});

describe("renderReminderDescription", () => {
  const blocks = [
    { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Call Sam" }] }] },
  ];

  test("renders blocks given as an array or as a JSON string", () => {
    expect(renderReminderDescription(blocks)).toBe("Call Sam");
    expect(renderReminderDescription(JSON.stringify(blocks))).toBe("Call Sam");
  });

  test("passes plain text through and gives nothing for other shapes", () => {
    expect(renderReminderDescription("  Call Sam ")).toBe("Call Sam");
    expect(renderReminderDescription({ text: "x" })).toBe("");
    expect(renderReminderDescription(undefined)).toBe("");
  });
});

describe("parseFilter", () => {
  test("accepts Slack's view names and the spellings people type", () => {
    expect(parseFilter("todo")).toBe("todo");
    expect(parseFilter("to-dos".replace("s", ""))).toBe("todo");
    expect(parseFilter("Saved")).toBe("saved");
    expect(parseFilter("done")).toBe("completed");
    expect(parseFilter("archive")).toBe("archived");
  });

  test("refuses an unknown view with the list of valid ones", () => {
    expect(() => parseFilter("later")).toThrow(/saved, todo, completed, or archived/);
    expect(() => parseFilter("overdue")).toThrow();
  });
});
