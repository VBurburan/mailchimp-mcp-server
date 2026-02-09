import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";

// ---------- Mailchimp API Client ----------

function getApiConfig() {
  const apiKey = process.env.MAILCHIMP_API_KEY || "";
  const dc = apiKey.split("-").pop() || "us1";
  return { apiKey, baseUrl: `https://${dc}.api.mailchimp.com/3.0` };
}

async function mc(method: string, path: string, body?: Record<string, unknown>, params?: Record<string, string>) {
  const { apiKey, baseUrl } = getApiConfig();
  if (!apiKey) throw new Error("MAILCHIMP_API_KEY not set. Format: <key>-<dc>");

  const url = new URL(`${baseUrl}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) return {};
  const data = await res.json();
  if (!res.ok) throw new Error(`Mailchimp ${res.status}: ${(data as Record<string, string>).detail || (data as Record<string, string>).title || "Error"}`);
  return data;
}

// ---------- Register Tools ----------

function createServer(): McpServer {
  const server = new McpServer({ name: "mailchimp-mcp-server", version: "1.0.0" });

  server.registerTool("mailchimp_list_audiences", {
    title: "List Audiences",
    description: "List all audiences (lists) with subscriber counts. You need an audience ID to create campaigns.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const data = await mc("GET", "/lists", undefined, { count: "100", fields: "lists.id,lists.name,lists.stats" }) as { lists: Array<{ id: string; name: string; stats: { member_count: number; open_rate: number; click_rate: number } }> };
    const out = data.lists.map(l => ({ id: l.id, name: l.name, subscribers: l.stats.member_count, open_rate: `${(l.stats.open_rate * 100).toFixed(1)}%`, click_rate: `${(l.stats.click_rate * 100).toFixed(1)}%` }));
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  });

  server.registerTool("mailchimp_list_campaigns", {
    title: "List Campaigns",
    description: "List recent campaigns. Filter by status: 'save' (draft), 'sent', 'schedule', 'sending'.",
    inputSchema: {
      status: z.enum(["save", "sent", "schedule", "sending", "paused"]).optional().describe("Filter by status. 'save' = drafts."),
      count: z.number().int().min(1).max(100).default(20).describe("Number to return"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ status, count }) => {
    const p: Record<string, string> = { count: String(count), sort_field: "create_time", sort_dir: "DESC" };
    if (status) p.status = status;
    const data = await mc("GET", "/campaigns", undefined, p) as { campaigns: Array<{ id: string; status: string; create_time: string; send_time?: string; emails_sent?: number; settings: { title?: string; subject_line?: string }; report_summary?: { unique_opens: number; subscriber_clicks: number } }> };
    const out = data.campaigns.map(c => ({
      id: c.id, title: c.settings.title || "(untitled)", subject: c.settings.subject_line || "(no subject)",
      status: c.status, created: c.create_time, sent: c.send_time || null,
      emails_sent: c.emails_sent || null, opens: c.report_summary?.unique_opens || null, clicks: c.report_summary?.subscriber_clicks || null,
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  });

  server.registerTool("mailchimp_create_campaign", {
    title: "Create Campaign",
    description: "Create a new draft email campaign. Returns the campaign_id for setting content and sending.",
    inputSchema: {
      list_id: z.string().describe("Audience ID (from mailchimp_list_audiences)"),
      subject: z.string().describe("Email subject line"),
      preview_text: z.string().optional().describe("Inbox preview text"),
      title: z.string().optional().describe("Internal campaign name"),
      from_name: z.string().describe("Sender name (e.g., 'Path2Medic')"),
      reply_to: z.string().email().describe("Reply-to email"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ list_id, subject, preview_text, title, from_name, reply_to }) => {
    const c = await mc("POST", "/campaigns", {
      type: "regular",
      recipients: { list_id },
      settings: { subject_line: subject, preview_text: preview_text || "", title: title || subject, from_name, reply_to },
    }) as { id: string; status: string; settings: { subject_line: string; title: string } };
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        campaign_id: c.id, status: c.status, subject: c.settings.subject_line,
        next: "Use mailchimp_set_content to add HTML, then mailchimp_send_test or mailchimp_send_campaign.",
      }, null, 2) }],
    };
  });

  server.registerTool("mailchimp_set_content", {
    title: "Set Campaign HTML Content",
    description: "Set the full HTML content of a campaign. Pass complete HTML with inline styles.",
    inputSchema: {
      campaign_id: z.string().describe("Campaign ID"),
      html: z.string().describe("Full HTML email content"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ campaign_id, html }) => {
    await mc("PUT", `/campaigns/${campaign_id}/content`, { html });
    return { content: [{ type: "text" as const, text: JSON.stringify({ campaign_id, message: "Content set. Use mailchimp_send_test to preview or mailchimp_send_campaign to send." }, null, 2) }] };
  });

  server.registerTool("mailchimp_send_test", {
    title: "Send Test Email",
    description: "Send a test/preview email to up to 5 addresses. Always do this before sending to your full list.",
    inputSchema: {
      campaign_id: z.string().describe("Campaign ID"),
      test_emails: z.array(z.string().email()).min(1).max(5).describe("Email addresses for the test"),
      send_type: z.enum(["html", "plaintext"]).default("html").describe("Format to send"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ campaign_id, test_emails, send_type }) => {
    await mc("POST", `/campaigns/${campaign_id}/actions/test`, { test_emails, send_type });
    return { content: [{ type: "text" as const, text: JSON.stringify({ campaign_id, sent_to: test_emails, message: "Test email sent. Check your inbox." }, null, 2) }] };
  });

  server.registerTool("mailchimp_send_campaign", {
    title: "Send Campaign",
    description: "Send campaign to full audience. IRREVERSIBLE. Always use mailchimp_send_test first.",
    inputSchema: {
      campaign_id: z.string().describe("Campaign ID to send"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ campaign_id }) => {
    await mc("POST", `/campaigns/${campaign_id}/actions/send`);
    return { content: [{ type: "text" as const, text: JSON.stringify({ campaign_id, message: "Campaign sent! Delivery may take a few minutes." }, null, 2) }] };
  });

  server.registerTool("mailchimp_schedule_campaign", {
    title: "Schedule Campaign",
    description: "Schedule a campaign for a future date/time.",
    inputSchema: {
      campaign_id: z.string().describe("Campaign ID"),
      schedule_time: z.string().describe("ISO 8601 datetime (e.g., '2026-02-14T10:00:00Z')"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ campaign_id, schedule_time }) => {
    await mc("POST", `/campaigns/${campaign_id}/actions/schedule`, { schedule_time });
    return { content: [{ type: "text" as const, text: JSON.stringify({ campaign_id, scheduled_for: schedule_time, message: "Scheduled." }, null, 2) }] };
  });

  server.registerTool("mailchimp_get_report", {
    title: "Get Campaign Report",
    description: "Get performance stats for a sent campaign — opens, clicks, bounces.",
    inputSchema: { campaign_id: z.string().describe("Campaign ID") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ campaign_id }) => {
    const r = await mc("GET", `/reports/${campaign_id}`) as Record<string, unknown>;
    return { content: [{ type: "text" as const, text: JSON.stringify({
      campaign_id, subject: r.subject_line, emails_sent: r.emails_sent,
      opens: (r.opens as Record<string, unknown>)?.unique_opens, open_rate: (r.opens as Record<string, unknown>)?.open_rate,
      clicks: (r.clicks as Record<string, unknown>)?.unique_subscriber_clicks, click_rate: (r.clicks as Record<string, unknown>)?.click_rate,
      unsubscribes: r.unsubscribed,
    }, null, 2) }] };
  });

  server.registerTool("mailchimp_delete_campaign", {
    title: "Delete Campaign",
    description: "Delete a draft campaign. Only works on unsent campaigns.",
    inputSchema: { campaign_id: z.string().describe("Campaign ID to delete") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ campaign_id }) => {
    await mc("DELETE", `/campaigns/${campaign_id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify({ campaign_id, message: "Deleted." }, null, 2) }] };
  });

  return server;
}

// ---------- Vercel Serverless Handler ----------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    res.json({ status: "ok", server: "mailchimp-mcp-server", version: "1.0.0" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
