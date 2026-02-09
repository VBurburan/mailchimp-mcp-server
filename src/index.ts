import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { mailchimpRequest } from "./services/mailchimp-client.js";

// ---------- Types ----------

interface MailchimpList {
  id: string;
  name: string;
  stats: {
    member_count: number;
    unsubscribe_count: number;
    open_rate: number;
    click_rate: number;
  };
}

interface MailchimpCampaign {
  id: string;
  web_id: number;
  type: string;
  status: string;
  create_time: string;
  send_time?: string;
  emails_sent?: number;
  settings: {
    subject_line?: string;
    preview_text?: string;
    title?: string;
    from_name?: string;
    reply_to?: string;
  };
  recipients?: {
    list_id?: string;
    list_name?: string;
  };
  report_summary?: {
    opens: number;
    unique_opens: number;
    open_rate: number;
    clicks: number;
    subscriber_clicks: number;
    click_rate: number;
  };
}

// ---------- Server ----------

const server = new McpServer({
  name: "mailchimp-mcp-server",
  version: "1.0.0",
});

// ---------- Tool: List Audiences ----------

server.registerTool(
  "mailchimp_list_audiences",
  {
    title: "List Mailchimp Audiences",
    description: `List all audiences (lists) in the Mailchimp account. Returns audience IDs, names, and subscriber stats. You need an audience ID to create campaigns.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const data = await mailchimpRequest<{ lists: MailchimpList[] }>({
      method: "GET",
      path: "/lists",
      params: { count: "100", fields: "lists.id,lists.name,lists.stats" },
    });

    const summary = data.lists.map((l) => ({
      id: l.id,
      name: l.name,
      subscribers: l.stats.member_count,
      open_rate: `${(l.stats.open_rate * 100).toFixed(1)}%`,
      click_rate: `${(l.stats.click_rate * 100).toFixed(1)}%`,
    }));

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// ---------- Tool: List Campaigns ----------

server.registerTool(
  "mailchimp_list_campaigns",
  {
    title: "List Mailchimp Campaigns",
    description: `List recent campaigns. Filter by status (save=draft, sent, schedule, sending). Returns campaign IDs, subjects, status, and stats.`,
    inputSchema: {
      status: z
        .enum(["save", "sent", "schedule", "sending", "paused"])
        .optional()
        .describe("Filter by campaign status. 'save' = draft campaigns."),
      count: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Number of campaigns to return"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ status, count }) => {
    const params: Record<string, string> = {
      count: String(count),
      sort_field: "create_time",
      sort_dir: "DESC",
    };
    if (status) params.status = status;

    const data = await mailchimpRequest<{ campaigns: MailchimpCampaign[] }>({
      method: "GET",
      path: "/campaigns",
      params,
    });

    const summary = data.campaigns.map((c) => ({
      id: c.id,
      title: c.settings.title || "(untitled)",
      subject: c.settings.subject_line || "(no subject)",
      status: c.status,
      created: c.create_time,
      sent: c.send_time || null,
      emails_sent: c.emails_sent || null,
      opens: c.report_summary?.unique_opens || null,
      clicks: c.report_summary?.subscriber_clicks || null,
    }));

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// ---------- Tool: Create Campaign ----------

server.registerTool(
  "mailchimp_create_campaign",
  {
    title: "Create Mailchimp Campaign",
    description: `Create a new email campaign draft in Mailchimp. Returns the campaign ID which you'll use to set content and send.

Args:
  - list_id: Audience/list ID to send to (get from mailchimp_list_audiences)
  - subject: Email subject line
  - preview_text: Preview text shown in inbox
  - title: Internal campaign title (not shown to recipients)
  - from_name: Sender name
  - reply_to: Reply-to email address`,
    inputSchema: {
      list_id: z.string().describe("Audience/list ID to send the campaign to"),
      subject: z.string().describe("Email subject line"),
      preview_text: z.string().optional().describe("Preview text shown in inbox after subject"),
      title: z.string().optional().describe("Internal campaign name (for your reference only)"),
      from_name: z.string().describe("Sender name (e.g., 'Path2Medic')"),
      reply_to: z.string().email().describe("Reply-to email address"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ list_id, subject, preview_text, title, from_name, reply_to }) => {
    const campaign = await mailchimpRequest<MailchimpCampaign>({
      method: "POST",
      path: "/campaigns",
      body: {
        type: "regular",
        recipients: { list_id },
        settings: {
          subject_line: subject,
          preview_text: preview_text || "",
          title: title || subject,
          from_name,
          reply_to,
        },
      },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              campaign_id: campaign.id,
              status: campaign.status,
              subject: campaign.settings.subject_line,
              title: campaign.settings.title,
              message: "Campaign draft created. Use mailchimp_set_campaign_content to add HTML, then mailchimp_send_test or mailchimp_send_campaign.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---------- Tool: Set Campaign Content ----------

server.registerTool(
  "mailchimp_set_campaign_content",
  {
    title: "Set Campaign HTML Content",
    description: `Set the HTML content of a campaign. Pass the full HTML email (with inline styles, tables, etc). Mailchimp will auto-generate the plain text version.

Args:
  - campaign_id: The campaign to update (from mailchimp_create_campaign)
  - html: Full HTML email content with inline styles`,
    inputSchema: {
      campaign_id: z.string().describe("Campaign ID to set content for"),
      html: z.string().describe("Full HTML email content"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ campaign_id, html }) => {
    await mailchimpRequest({
      method: "PUT",
      path: `/campaigns/${campaign_id}/content`,
      body: { html },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              campaign_id,
              message: "HTML content set successfully. Use mailchimp_send_test to preview, or mailchimp_send_campaign to send to your full list.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---------- Tool: Send Test Email ----------

server.registerTool(
  "mailchimp_send_test",
  {
    title: "Send Test Email",
    description: `Send a test/preview email of a campaign to one or more email addresses. Use this to review the email before sending to your full list.

Args:
  - campaign_id: Campaign to test
  - test_emails: Array of email addresses to send the test to
  - send_type: 'html' or 'plaintext'`,
    inputSchema: {
      campaign_id: z.string().describe("Campaign ID to send test for"),
      test_emails: z
        .array(z.string().email())
        .min(1)
        .max(5)
        .describe("Email addresses to receive the test (max 5)"),
      send_type: z
        .enum(["html", "plaintext"])
        .default("html")
        .describe("Send HTML or plaintext version"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ campaign_id, test_emails, send_type }) => {
    await mailchimpRequest({
      method: "POST",
      path: `/campaigns/${campaign_id}/actions/test`,
      body: { test_emails, send_type },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              campaign_id,
              sent_to: test_emails,
              message: "Test email sent. Check your inbox to preview.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---------- Tool: Send Campaign ----------

server.registerTool(
  "mailchimp_send_campaign",
  {
    title: "Send Campaign",
    description: `Send a campaign to the full audience list. This is irreversible — the email will be delivered to all subscribers. Use mailchimp_send_test first to verify content.

Args:
  - campaign_id: Campaign ID to send`,
    inputSchema: {
      campaign_id: z.string().describe("Campaign ID to send"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ campaign_id }) => {
    await mailchimpRequest({
      method: "POST",
      path: `/campaigns/${campaign_id}/actions/send`,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              campaign_id,
              message: "Campaign sent! It may take a few minutes to deliver to all subscribers.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---------- Tool: Schedule Campaign ----------

server.registerTool(
  "mailchimp_schedule_campaign",
  {
    title: "Schedule Campaign",
    description: `Schedule a campaign to send at a specific date and time.

Args:
  - campaign_id: Campaign ID to schedule
  - schedule_time: ISO 8601 datetime (e.g., '2026-02-14T10:00:00Z')`,
    inputSchema: {
      campaign_id: z.string().describe("Campaign ID to schedule"),
      schedule_time: z.string().describe("Send time in ISO 8601 format (e.g., '2026-02-14T10:00:00Z')"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ campaign_id, schedule_time }) => {
    await mailchimpRequest({
      method: "POST",
      path: `/campaigns/${campaign_id}/actions/schedule`,
      body: { schedule_time },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              campaign_id,
              scheduled_for: schedule_time,
              message: "Campaign scheduled successfully.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---------- Tool: Get Campaign Report ----------

server.registerTool(
  "mailchimp_get_campaign_report",
  {
    title: "Get Campaign Report",
    description: `Get performance stats for a sent campaign — opens, clicks, bounces, unsubscribes.

Args:
  - campaign_id: Campaign ID to get report for`,
    inputSchema: {
      campaign_id: z.string().describe("Campaign ID"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ campaign_id }) => {
    const report = await mailchimpRequest<Record<string, unknown>>({
      method: "GET",
      path: `/reports/${campaign_id}`,
    });

    const summary = {
      campaign_id,
      subject: (report as Record<string, unknown>).subject_line,
      emails_sent: report.emails_sent,
      opens: (report as Record<string, Record<string, unknown>>).opens?.unique_opens,
      open_rate: (report as Record<string, Record<string, unknown>>).opens?.open_rate,
      clicks: (report as Record<string, Record<string, unknown>>).clicks?.unique_subscriber_clicks,
      click_rate: (report as Record<string, Record<string, unknown>>).clicks?.click_rate,
      bounces: report.bounces,
      unsubscribes: report.unsubscribed,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// ---------- Tool: Delete Campaign ----------

server.registerTool(
  "mailchimp_delete_campaign",
  {
    title: "Delete Campaign",
    description: `Delete a campaign. Only works on campaigns that haven't been sent.

Args:
  - campaign_id: Campaign ID to delete`,
    inputSchema: {
      campaign_id: z.string().describe("Campaign ID to delete"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ campaign_id }) => {
    await mailchimpRequest({
      method: "DELETE",
      path: `/campaigns/${campaign_id}`,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ campaign_id, message: "Campaign deleted." }, null, 2),
        },
      ],
    };
  }
);

// ---------- HTTP Transport (Vercel-compatible) ----------

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "mailchimp-mcp-server" });
  });

  const port = parseInt(process.env.PORT || "3000");
  app.listen(port, () => {
    console.error(`Mailchimp MCP server running on http://localhost:${port}/mcp`);
  });
}

runHTTP().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
